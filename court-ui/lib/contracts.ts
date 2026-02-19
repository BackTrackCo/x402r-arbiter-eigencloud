import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { baseSepolia, sepolia } from "viem/chains";
import type { Chain } from "viem";

const ARBITER_URL =
  process.env.NEXT_PUBLIC_ARBITER_URL || "http://localhost:3000";

// Chain lookup
const CHAINS: Record<number, Chain> = {
  84532: baseSepolia,
  11155111: sepolia,
};

// Dynamic config fetched from arbiter server
interface ContractsConfig {
  chainId: number;
  rpcUrl: string;
  escrowAddress: Address;
  refundRequestAddress: Address;
  evidenceAddress: Address;
  usdcAddress: Address;
}

let _config: ContractsConfig | null = null;
let _client: PublicClient | null = null;

async function getConfig(): Promise<ContractsConfig> {
  if (_config) return _config;
  const res = await fetch(`${ARBITER_URL}/api/contracts`);
  if (!res.ok) throw new Error(`Failed to fetch contracts config: ${res.status}`);
  _config = (await res.json()) as ContractsConfig;
  return _config;
}

async function getClient(): Promise<PublicClient> {
  if (_client) return _client;
  const config = await getConfig();
  const chain = CHAINS[config.chainId] ?? baseSepolia;
  _client = createPublicClient({
    chain,
    transport: http(config.rpcUrl),
  });
  return _client;
}

const paymentInfoComponents = [
  { name: "operator", type: "address" },
  { name: "payer", type: "address" },
  { name: "receiver", type: "address" },
  { name: "token", type: "address" },
  { name: "maxAmount", type: "uint120" },
  { name: "preApprovalExpiry", type: "uint48" },
  { name: "authorizationExpiry", type: "uint48" },
  { name: "refundExpiry", type: "uint48" },
  { name: "minFeeBps", type: "uint16" },
  { name: "maxFeeBps", type: "uint16" },
  { name: "feeReceiver", type: "address" },
  { name: "salt", type: "uint256" },
] as const;

export const RefundRequestEvidenceABI = [
  {
    type: "function",
    name: "getEvidenceCount",
    inputs: [
      {
        name: "paymentInfo",
        type: "tuple",
        components: paymentInfoComponents,
      },
      { name: "nonce", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getEvidence",
    inputs: [
      {
        name: "paymentInfo",
        type: "tuple",
        components: paymentInfoComponents,
      },
      { name: "nonce", type: "uint256" },
      { name: "index", type: "uint256" },
    ],
    outputs: [
      { name: "submitter", type: "address" },
      { name: "role", type: "uint8" },
      { name: "timestamp", type: "uint256" },
      { name: "cid", type: "string" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getEvidenceBatch",
    inputs: [
      {
        name: "paymentInfo",
        type: "tuple",
        components: paymentInfoComponents,
      },
      { name: "nonce", type: "uint256" },
      { name: "offset", type: "uint256" },
      { name: "count", type: "uint256" },
    ],
    outputs: [
      {
        name: "entries",
        type: "tuple[]",
        components: [
          { name: "submitter", type: "address" },
          { name: "role", type: "uint8" },
          { name: "timestamp", type: "uint256" },
          { name: "cid", type: "string" },
        ],
      },
      { name: "total", type: "uint256" },
    ],
    stateMutability: "view",
  },
] as const;

export interface EvidenceEntry {
  submitter: string;
  role: number;
  timestamp: bigint;
  cid: string;
}

export async function getEvidenceCount(
  paymentInfo: Record<string, unknown>,
  nonce: bigint,
): Promise<bigint> {
  const [client, config] = await Promise.all([getClient(), getConfig()]);
  return client.readContract({
    address: config.evidenceAddress,
    abi: RefundRequestEvidenceABI,
    functionName: "getEvidenceCount",
    args: [paymentInfo as never, nonce],
  }) as Promise<bigint>;
}

export async function getEvidenceBatch(
  paymentInfo: Record<string, unknown>,
  nonce: bigint,
  offset = 0n,
  count = 50n,
): Promise<{ entries: EvidenceEntry[]; total: bigint }> {
  const [client, config] = await Promise.all([getClient(), getConfig()]);
  const result = await client.readContract({
    address: config.evidenceAddress,
    abi: RefundRequestEvidenceABI,
    functionName: "getEvidenceBatch",
    args: [paymentInfo as never, nonce, offset, count],
  });
  const [entries, total] = result as [EvidenceEntry[], bigint];
  return { entries, total };
}
