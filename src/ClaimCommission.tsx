import { useCurrentAccount, useCurrentClient, useDAppKit } from "@mysten/dapp-kit-react";
import { Transaction, TransactionArgument } from "@mysten/sui/transactions";

import { useEffect, useState } from "react";
import {
	Badge,
	Button,
	Callout,
	Card,
	Code,
	Flex,
	Heading,
	IconButton,
	Link,
	SegmentedControl,
	Table,
	Text,
	TextField,
} from "@radix-ui/themes";
import { InfoCircledIcon, ArrowTopRightIcon, CheckIcon } from "@radix-ui/react-icons";

import { MoveStruct, NodeType } from "./types.tsx";
import { STAKING_OBJ, WALRUS_PKG } from "./constants.ts";

// The Walrus staking table whose dynamic fields map node IDs to their NodeInfo/StakingPool objects.
const STAKING_TABLE_ID = "0x23ec98c791548aad0712822afab68a2a8c2a548b346193873cc80eb2f66d5b5e";

// The public Sui GraphQL endpoint enforces a 5KB query-payload limit. The SDK's `getObjects`
// query document is ~1.2KB, so each requested object ID (~78B) leaves room for ~40 IDs per
// batch before the serialized request exceeds the limit.
const FETCH_BATCH_SIZE = 40;

type TableView = "none" | "nodes" | "wallets";

function prepareTransaction(nodeId: string | undefined): Transaction | null {
	if (!nodeId) {
		alert("Node ID is required");
		return null;
	}
	const tx = new Transaction();
	// Step 1: Get sender
	const sender = tx.moveCall({
		target: "0x2::tx_context::sender",
	});

	// Step 2: Authenticate sender
	const authenticated_obj = tx.moveCall({
		target: `${WALRUS_PKG}::auth::authenticate_sender`,
	});

	// Step 3: Collect commission
	const commission = tx.moveCall({
		target: `${WALRUS_PKG}::staking::collect_commission`,
		arguments: [tx.object(STAKING_OBJ), tx.pure.address(nodeId), authenticated_obj as TransactionArgument],
	});

	// Step 4: Transfer commission to sender
	tx.transferObjects([commission], sender);

	return tx;
}

// Unwrap a Move struct value into its fields. Different Sui data-access APIs represent nested
// structs differently: JSON-RPC wraps them as `{ dataType, type, fields }`, while the GraphQL
// `MoveValue.json` representation returns structs as plain objects of their fields. This helper
// normalizes both so the same field-access logic works regardless of the underlying transport.
function getFields(value: unknown): MoveStruct | null {
	if (value && typeof value === "object" && !Array.isArray(value) && "fields" in value) {
		const fields = (value as { fields: unknown }).fields;
		if (fields && typeof fields === "object" && !Array.isArray(fields)) {
			return fields as MoveStruct;
		}
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as MoveStruct;
	}
	return null;
}

function ClaimCommission() {
	const dAppKit = useDAppKit();
	const client = useCurrentClient();
	const [node, setNode] = useState<NodeType | null>(null);
	const [multipleNodes, setMultipleNodes] = useState<NodeType[]>([]);
	const [allNodes, setAllNodes] = useState<Record<string, NodeType>>({});
	const [tableView, setTableView] = useState<TableView>("none");
	const [digest, setDigest] = useState("");
	const [error, setError] = useState("");
	const [manualNodeId, setManualNodeId] = useState("");
	const currentAccount = useCurrentAccount();

	const executeTransaction = async () => {
		const nodeId = node?.nodeId ?? manualNodeId;
		const tx = prepareTransaction(nodeId);
		if (!tx) {
			return;
		}

		try {
			const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
			const txResult = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
			setDigest(txResult?.digest ?? "");
		} catch (err) {
			setError((err as Error)?.message ?? "Transaction failed");
			console.error("Transaction failed:", err);
		}
	};

	useEffect(() => {
		setNode(null);
		setMultipleNodes([]);
		setDigest("");
		setError("");
		setManualNodeId("");

		const fetchNodeData = async () => {
			let hasNextPage = false;
			let cursor: string | null = null;
			const nodesObjIds: string[] = [];
			do {
				const nodeRes = await client.core.listDynamicFields({
					parentId: STAKING_TABLE_ID,
					cursor,
					limit: 50,
				});
				for (const df of nodeRes.dynamicFields) {
					if (df.childId) {
						nodesObjIds.push(df.childId);
					}
				}
				hasNextPage = nodeRes.hasNextPage;
				cursor = nodeRes.cursor;
			} while (hasNextPage);

			const nodeData: Record<
				string,
				{ name: string; nodeId: string; commissionReceiver: string; type: string; commission: number }
			> = {};
			for (let i = 0; i < nodesObjIds.length; i += FETCH_BATCH_SIZE) {
				const ids = nodesObjIds.slice(i, i + FETCH_BATCH_SIZE);
				const res = await client.core.getObjects({
					objectIds: ids,
					include: {
						json: true,
					},
				});

				for (const obj of res.objects) {
					if (obj instanceof Error) {
						console.error("Object not found:", obj.message);
						continue;
					}
					const fields = getFields(obj.json);
					if (!fields) continue;

					const commission = Number(fields["commission"] ?? 0);
					const commissionReceiver = getFields(fields["commission_receiver"])?.["pos0"];
					const nodeInfo = getFields(fields["node_info"]);

					if (!commissionReceiver || !nodeInfo) continue;

					const nodeId = String(nodeInfo["node_id"] ?? "");
					if (!nodeId) continue;

					nodeData[nodeId] = {
						name: String(nodeInfo["name"] ?? ""),
						nodeId,
						commission: Number((commission / 10 ** 9).toFixed(2)),
						commissionReceiver: String(commissionReceiver),
						type: "",
					};
				}
			}

			for (let i = 0; i < Object.keys(nodeData).length; i += FETCH_BATCH_SIZE) {
				const walletIds = Object.values(nodeData)
					.map((x) => x.commissionReceiver)
					.slice(i, i + FETCH_BATCH_SIZE);
				const uniqueWalletIds = [...new Set(walletIds)];

				const res = await client.core.getObjects({
					objectIds: uniqueWalletIds,
				});

				res.objects.forEach((obj, idx) => {
					const address = uniqueWalletIds[idx];
					let type: string = "Wallet";
					if (!(obj instanceof Error) && obj.type) {
						const seg = obj.type.split("::")[2];
						type = seg ?? "Wallet";
					}
					for (const n of Object.values(nodeData)) {
						if (n.commissionReceiver === address) {
							nodeData[n.nodeId].type = type;
						}
					}
				});
			}

			const activeWallet = currentAccount?.address;
			if (!activeWallet) return;
			setAllNodes(nodeData);
			const selectedNodes = Object.values(nodeData).filter((n) => n.commissionReceiver === activeWallet);

			if (!selectedNodes.length) {
				setError("The wallet isn't associated with any node");
				console.error("Node not found");
				return;
			}

			if (selectedNodes.length > 1) {
				setMultipleNodes(selectedNodes);
				setNode(null);
				return;
			}

			setNode(selectedNodes[0]);
			setMultipleNodes([]);
		};

		fetchNodeData().catch(console.error);
	}, [currentAccount, client]);

	const showManualFallback = !node && !!error && !multipleNodes.length;

	return (
		<Flex direction="column" gap="4" style={{ padding: 20 }}>
			{!node && !multipleNodes.length && !error && (
				<Text as="p" size="3" color="gray">
					Checking if the active wallet belongs to a node...
				</Text>
			)}

			{/* Single node → claim flow */}
			{node && !showManualFallback && (
				<Card size="4">
					<Flex direction="column" gap="3">
						<Heading size="4">{node.name}</Heading>

						<Flex align="center" gap="2" wrap="wrap">
							<Badge variant="surface" color="iris">
								Node ID
							</Badge>
							<Code>{node.nodeId}</Code>
						</Flex>

						{node.commission === 0 && (
							<Callout.Root color="amber" variant="soft">
								<Callout.Icon>
									<InfoCircledIcon />
								</Callout.Icon>
								<Callout.Text>
									No commission assigned at this time. Please check again next epoch.
								</Callout.Text>
							</Callout.Root>
						)}

						{node.type === "StorageNodeCap" && (
							<Callout.Root color="ruby" variant="soft">
								<Callout.Icon>
									<InfoCircledIcon />
								</Callout.Icon>
								<Callout.Text>Unsupported wallet type, please claim using the CLI.</Callout.Text>
							</Callout.Root>
						)}

						{node.commission > 0 && (
							<Badge variant="surface" color="green" size="2">
								Available commission: {node.commission} WAL
							</Badge>
						)}

						{node.commission > 0 && node.type !== "StorageNodeCap" && (
							<Button onClick={executeTransaction}>{`Claim commission (${node.commission} WAL)`}</Button>
						)}
					</Flex>
				</Card>
			)}

			{/* Multiple nodes → pick one */}
			{multipleNodes.length > 0 && (
				<Card size="4">
					<Flex direction="column" gap="3">
						<Heading size="4">Multiple nodes found for this wallet</Heading>
						<Text size="3" color="gray">
							Select the node to claim commission for.
						</Text>
						<Flex direction="column" gap="2">
							{multipleNodes
								.slice()
								.sort((a, b) => a.name.localeCompare(b.name))
								.map((n) => (
									<Flex key={n.nodeId} justify="between" align="center" gap="2">
										<Text as="span" size="3">
											{n.name} · <Code>{n.nodeId}</Code>
										</Text>
										<Button
											size="2"
											onClick={() => {
												setNode(n);
												setMultipleNodes([]);
											}}
										>
											Select node
										</Button>
									</Flex>
								))}
						</Flex>
					</Flex>
				</Card>
			)}

			{/* Error → manual node id fallback */}
			{showManualFallback && (
				<Card size="4" variant="surface">
					<Flex direction="column" gap="3">
						<Callout.Root color="ruby" variant="soft">
							<Callout.Icon>
								<InfoCircledIcon />
							</Callout.Icon>
							<Callout.Text>Error: {error}</Callout.Text>
						</Callout.Root>
						<Text size="3">Enter your Node ID to try claiming manually:</Text>
						<TextField.Root value={manualNodeId} onChange={(e) => setManualNodeId(e.target.value)}>
							<TextField.Slot aria-label="Node ID">
								<InfoCircledIcon />
							</TextField.Slot>
						</TextField.Root>
						{manualNodeId && (
							<Text size="2" color="ruby">
								This is a manual operation, claim may not work.
							</Text>
						)}
						<Button disabled={manualNodeId === ""} onClick={executeTransaction}>
							Claim Commission
						</Button>
					</Flex>
				</Card>
			)}

			{digest && (
				<Flex align="center" gap="2">
					<Text size="3" weight="medium">
						Digest:
					</Text>
					<Link
						href={`https://suiscan.xyz/mainnet/tx/${digest}`}
						target="_blank"
						rel="noreferrer"
						underline="hover"
					>
						<Code>{digest}</Code> <ArrowTopRightIcon />
					</Link>
				</Flex>
			)}

			{/* All-nodes explorer */}
			{Object.keys(allNodes).length !== 0 && (
				<Card size="4">
					<Flex direction="column" gap="3">
						<Flex justify="between" align="center">
							<Heading size="4">Nodes on mainnet</Heading>
							<Badge variant="soft" color="gray">
								{Object.keys(allNodes).length} nodes
							</Badge>
						</Flex>

						<SegmentedControl.Root
							size="1"
							value={tableView}
							onValueChange={(v: string) => setTableView((v ?? "none") as TableView)}
						>
							<SegmentedControl.Item value="none">Hide</SegmentedControl.Item>
							<SegmentedControl.Item value="nodes">All nodes</SegmentedControl.Item>
							<SegmentedControl.Item value="wallets">Commission wallets</SegmentedControl.Item>
						</SegmentedControl.Root>

						{tableView === "nodes" && (
							<NodesTable allNodes={allNodes} setNode={setNode} setManualNodeId={setManualNodeId} />
						)}

						{tableView === "wallets" && <WalletsTable allNodes={allNodes} />}
					</Flex>
				</Card>
			)}
		</Flex>
	);
}

function NodesTable({
	allNodes,
	setNode,
	setManualNodeId,
}: {
	allNodes: Record<string, NodeType>;
	setNode: (n: NodeType | null) => void;
	setManualNodeId: (id: string) => void;
}) {
	const rows = Object.keys(allNodes).sort((a, b) => allNodes[a].name.localeCompare(allNodes[b].name));

	return (
		<Table.Root variant="ghost">
			<Table.Header>
				<Table.Row>
					<Table.ColumnHeaderCell>Name</Table.ColumnHeaderCell>
					<Table.ColumnHeaderCell>Node ID</Table.ColumnHeaderCell>
					<Table.ColumnHeaderCell>Commission</Table.ColumnHeaderCell>
					<Table.ColumnHeaderCell>Manual set</Table.ColumnHeaderCell>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{rows.map((key) => {
					const node = allNodes[key];
					return (
						<Table.Row key={key}>
							<Table.Cell>{node.name}</Table.Cell>
							<Table.Cell>
								<Code>{node.nodeId}</Code>
							</Table.Cell>
							<Table.Cell>{node.commission} WAL</Table.Cell>
							<Table.Cell>
								<IconButton
									size="1"
									variant="ghost"
									aria-label={`Use ${node.name}`}
									onClick={() => {
										setNode(node);
										setManualNodeId(node.nodeId);
									}}
								>
									<CheckIcon />
								</IconButton>
							</Table.Cell>
						</Table.Row>
					);
				})}
			</Table.Body>
		</Table.Root>
	);
}

function WalletsTable({ allNodes }: { allNodes: Record<string, NodeType> }) {
	const rows = Object.keys(allNodes).sort((a, b) => allNodes[a].name.localeCompare(allNodes[b].name));

	return (
		<Table.Root variant="ghost">
			<Table.Header>
				<Table.Row>
					<Table.ColumnHeaderCell>Name</Table.ColumnHeaderCell>
					<Table.ColumnHeaderCell>Commission Wallet</Table.ColumnHeaderCell>
					<Table.ColumnHeaderCell>Type</Table.ColumnHeaderCell>
				</Table.Row>
			</Table.Header>
			<Table.Body>
				{rows.map((key) => {
					const node = allNodes[key];
					return (
						<Table.Row key={key}>
							<Table.Cell>{node.name}</Table.Cell>
							<Table.Cell>
								<Code>{node.commissionReceiver}</Code>
							</Table.Cell>
							<Table.Cell>
								<Badge variant="surface" color="iris">
									{node.type}
								</Badge>
							</Table.Cell>
						</Table.Row>
					);
				})}
			</Table.Body>
		</Table.Root>
	);
}

export default ClaimCommission;
