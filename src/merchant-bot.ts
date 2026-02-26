/**
 * Merchant Dispute Bot
 *
 * Standalone watcher that auto-submits merchant evidence when a payer
 * files a refund request. Runs independently from the merchant server.
 *
 * On startup, scans recent blocks for existing disputes and submits
 * evidence for any that don't already have merchant evidence. Then
 * watches for new disputes in real-time.
 *
 * Reads the merchant private key from ~/.x402r/last-payment.json
 * (saved by the e2e test) so it can submit evidence as the actual
 * paymentInfo.receiver. Falls back to MERCHANT_PRIVATE_KEY env var.
 *
 * If OPERATOR_ADDRESS is not set, fetches it from the arbiter server.
 *
 * Usage: pnpm merchant:bot
 *
 * Env:
 *   MERCHANT_PRIVATE_KEY or PRIVATE_KEY  — fallback merchant wallet
 *   OPERATOR_ADDRESS                     — operator contract (or auto-detect from arbiter)
 *   CHAIN_ID                             — chain (default: 84532)
 *   RPC_URL                              — optional custom RPC
 */

import dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Chain,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, base, sepolia } from "viem/chains";
import {
  resolveAddresses,
  RefundRequestABI,
  type PaymentInfo,
} from "@x402r/core";
import { X402rMerchant } from "@x402r/merchant";

dotenv.config();

const ENV_PRIVATE_KEY = process.env.MERCHANT_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
const PINATA_JWT = process.env.PINATA_JWT;
const CHAIN_ID = parseInt(process.env.CHAIN_ID ?? "84532", 10);
const RPC_URL = process.env.RPC_URL;
const MAX_BLOCK_RANGE = CHAIN_ID === 11155111 ? 1000n : CHAIN_ID === 84532 ? 9000n : 50000n;
const STATE_FILE = path.join(os.homedir(), ".x402r", "last-payment.json");

const CHAINS: Record<number, Chain> = {
  84532: baseSepolia,
  8453: base,
  11155111: sepolia,
};
const chain = CHAINS[CHAIN_ID];
if (!chain) {
  console.error(`Unsupported CHAIN_ID: ${CHAIN_ID}`);
  process.exit(1);
}

const networkId = `eip155:${CHAIN_ID}`;
const transport = http(RPC_URL);
const publicClient = createPublicClient({ chain, transport });
const addresses = resolveAddresses(networkId);

/** Read merchant private key from state file (saved by e2e test) */
function loadMerchantKeyFromState(): string | null {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    return raw.merchantPrivateKey ?? null;
  } catch {
    return null;
  }
}

/** Get the best available merchant private key */
function getMerchantKey(): string | null {
  return loadMerchantKeyFromState() ?? ENV_PRIVATE_KEY ?? null;
}

/** Resolve operator address from env or arbiter server */
async function resolveOperator(): Promise<Address> {
  if (process.env.OPERATOR_ADDRESS) return process.env.OPERATOR_ADDRESS as Address;
  // Wait for arbiter to be ready (it auto-deploys the operator)
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch("http://localhost:3000/api/contracts");
      if (res.ok) {
        const data = (await res.json()) as { operatorAddress?: string };
        if (data.operatorAddress) return data.operatorAddress as Address;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.error("Could not resolve OPERATOR_ADDRESS. Set it in env or start the arbiter first.");
  process.exit(1);
}

/** Pin JSON to IPFS via Pinata, or fall back to inline JSON string */
async function pinToIpfs(data: Record<string, unknown>): Promise<string> {
  const json = JSON.stringify(data);

  if (PINATA_JWT) {
    try {
      const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${PINATA_JWT}`,
        },
        body: JSON.stringify({ pinataContent: data, pinataMetadata: { name: `x402r-merchant-evidence-${Date.now()}` } }),
      });
      if (res.ok) {
        const result = (await res.json()) as { IpfsHash: string };
        console.log(`  Pinned to IPFS: ${result.IpfsHash}`);
        return result.IpfsHash;
      }
      console.warn(`  Pinata failed (${res.status}) — using placeholder CID`);
    } catch (err) {
      console.warn(`  Pinata error:`, err instanceof Error ? err.message : err);
    }
  }

  // No Pinata — use pre-pinned placeholder CID
  return "QmSkEzmGCrBHp4f3iJxRQN9xcuaPL4Zb5dxo8CSTzUneBE";
}

const processed = new Set<string>();

async function main() {
  const OPERATOR_ADDRESS = await resolveOperator();

  const merchantKey = getMerchantKey();
  if (!merchantKey) {
    console.error("No merchant key found. Set MERCHANT_PRIVATE_KEY or run the e2e test first.");
    process.exit(1);
  }

  /** Cache of privateKey → X402rMerchant instances */
  const merchantInstances = new Map<string, { merchant: X402rMerchant; address: Address }>();

  function getMerchant(privateKey: string): { merchant: X402rMerchant; address: Address } {
    const cached = merchantInstances.get(privateKey);
    if (cached) return cached;

    const account = privateKeyToAccount(privateKey as `0x${string}`);
    const walletClient = createWalletClient({ account, chain, transport });
    const m = new X402rMerchant({
      publicClient: publicClient as any,
      walletClient: walletClient as any,
      operatorAddress: OPERATOR_ADDRESS,
      escrowAddress: addresses.escrowAddress,
      refundRequestAddress: addresses.refundRequestAddress,
      refundRequestEvidenceAddress: addresses.evidenceAddress,
      chainId: CHAIN_ID,
    });
    const entry = { merchant: m, address: account.address };
    merchantInstances.set(privateKey, entry);
    return entry;
  }

  const { address: botAddress } = getMerchant(merchantKey);
  console.log("MoltArbiter Merchant Bot");
  console.log(`  Wallet:   ${botAddress}`);
  console.log(`  Operator: ${OPERATOR_ADDRESS}`);
  console.log(`  Network:  ${networkId} (${chain.name})`);
  console.log(`  Key source: ${loadMerchantKeyFromState() ? "~/.x402r/last-payment.json" : "env var"}`);

  /** Submit merchant counter-evidence for a dispute */
  async function handleDispute(paymentInfo: PaymentInfo, nonce: bigint, key: string) {
    if (processed.has(key)) return;
    processed.add(key);

    // Only respond to disputes on our operator
    if (paymentInfo.operator.toLowerCase() !== OPERATOR_ADDRESS.toLowerCase()) return;

    console.log(
      `\n[${new Date().toISOString()}] Processing dispute: payer=${paymentInfo.payer.slice(0, 10)}... receiver=${paymentInfo.receiver.slice(0, 10)}... nonce=${nonce}`,
    );

    // Re-read key from state file each time (e2e test may have run again)
    const currentKey = getMerchantKey();
    if (!currentKey) {
      console.log(`  No merchant key available — skipping`);
      return;
    }

    const { merchant, address } = getMerchant(currentKey);

    // Check if our wallet matches the receiver
    if (address.toLowerCase() !== paymentInfo.receiver.toLowerCase()) {
      console.log(`  Bot wallet ${address.slice(0, 10)}... doesn't match receiver ${paymentInfo.receiver.slice(0, 10)}... — skipping`);
      return;
    }

    try {
      const existing = await merchant.getAllEvidence(paymentInfo, nonce);
      const alreadyHasMerchantEvidence = existing.some(
        (e) => e.submitter.toLowerCase() === address.toLowerCase() ||
               e.submitter.toLowerCase() === paymentInfo.receiver.toLowerCase()
      );
      if (alreadyHasMerchantEvidence) {
        console.log(`  Evidence already submitted — skipping`);
        return;
      }

      const evidenceData = {
        type: "merchant-response",
        message:
          "Service was delivered as described. The API endpoint returned valid weather data.",
        serviceDelivered: true,
        endpoint: "/weather",
        timestamp: new Date().toISOString(),
      };

      const evidence = await pinToIpfs(evidenceData);

      const { txHash } = await merchant.submitEvidence(
        paymentInfo,
        nonce,
        evidence,
      );
      console.log(`  Evidence submitted: ${txHash}`);
      console.log(`  Waiting for confirmation...`);
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      console.log(`  Confirmed.`);
    } catch (err) {
      console.error(`  Failed to submit evidence:`, err instanceof Error ? err.message : err);
    }
  }

  /** Scan recent blocks for existing disputes */
  async function scanExistingDisputes() {
    console.log(`\n  Scanning recent blocks for existing disputes...`);
    try {
      const toBlock = await publicClient.getBlockNumber();
      const fromBlock = toBlock > MAX_BLOCK_RANGE ? toBlock - MAX_BLOCK_RANGE : 0n;

      const logs = await publicClient.getContractEvents({
        address: addresses.refundRequestAddress as Address,
        abi: RefundRequestABI,
        eventName: "RefundRequested",
        fromBlock,
        toBlock,
      });

      let count = 0;
      for (const log of logs) {
        const args = log.args as any;
        if (!args.paymentInfo || args.nonce === undefined) continue;

        const paymentInfo: PaymentInfo = {
          operator: args.paymentInfo.operator,
          payer: args.paymentInfo.payer,
          receiver: args.paymentInfo.receiver,
          token: args.paymentInfo.token,
          maxAmount: args.paymentInfo.maxAmount,
          preApprovalExpiry: args.paymentInfo.preApprovalExpiry,
          authorizationExpiry: args.paymentInfo.authorizationExpiry,
          refundExpiry: args.paymentInfo.refundExpiry,
          minFeeBps: args.paymentInfo.minFeeBps,
          maxFeeBps: args.paymentInfo.maxFeeBps,
          feeReceiver: args.paymentInfo.feeReceiver,
          salt: args.paymentInfo.salt,
        };
        const nonce = BigInt(args.nonce);
        const key = `${log.transactionHash}-${nonce}`;

        await handleDispute(paymentInfo, nonce, key);
        count++;
      }

      console.log(`  Scanned ${count} existing disputes (blocks ${fromBlock}–${toBlock})`);
    } catch (err) {
      console.error("  Failed to scan existing disputes:", err instanceof Error ? err.message : err);
    }
  }

  // 1. Scan existing disputes on startup
  await scanExistingDisputes();

  // 2. Re-scan every 15s to catch new disputes (more reliable than watchContractEvent)
  console.log(`\n  Polling for new disputes every 15s...`);
  setInterval(async () => {
    try {
      await scanExistingDisputes();
    } catch (err) {
      console.error("  Poll error:", err instanceof Error ? err.message : err);
    }
  }, 15_000);
}

main().catch((err) => {
  console.error("Merchant bot failed:", err);
  process.exit(1);
});
