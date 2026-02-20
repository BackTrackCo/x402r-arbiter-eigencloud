/**
 * Merchant Dispute Bot
 *
 * Standalone watcher that auto-submits merchant evidence when a payer
 * files a refund request. Runs independently from the merchant server.
 *
 * Usage: pnpm merchant:bot
 *
 * Env:
 *   MERCHANT_PRIVATE_KEY or PRIVATE_KEY  — merchant wallet
 *   OPERATOR_ADDRESS                     — operator contract (default: 0xAfD0...)
 *   CHAIN_ID                             — chain (default: 84532)
 *   RPC_URL                              — optional custom RPC
 */

import dotenv from "dotenv";
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

const PRIVATE_KEY = process.env.MERCHANT_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
const OPERATOR_ADDRESS = (process.env.OPERATOR_ADDRESS ??
  "0xAfD051239DE540D7B51Aa514eb795a2D43C8fCb0") as Address;
const CHAIN_ID = parseInt(process.env.CHAIN_ID ?? "84532", 10);
const RPC_URL = process.env.RPC_URL;

if (!PRIVATE_KEY) {
  console.error(
    "MERCHANT_PRIVATE_KEY or PRIVATE_KEY is required",
  );
  process.exit(1);
}

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
const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
const transport = http(RPC_URL);

const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ account, chain, transport });
const addresses = resolveAddresses(networkId);

const merchant = new X402rMerchant({
  publicClient: publicClient as any,
  walletClient: walletClient as any,
  operatorAddress: OPERATOR_ADDRESS,
  escrowAddress: addresses.escrowAddress,
  refundRequestAddress: addresses.refundRequestAddress,
  refundRequestEvidenceAddress: addresses.evidenceAddress,
  chainId: CHAIN_ID,
});

const processed = new Set<string>();

console.log("x402r Merchant Dispute Bot");
console.log(`  Merchant: ${account.address}`);
console.log(`  Operator: ${OPERATOR_ADDRESS}`);
console.log(`  Network: ${networkId} (${chain.name})`);
console.log(`  Watching for refund requests...`);

publicClient.watchContractEvent({
  address: addresses.refundRequestAddress as Address,
  abi: RefundRequestABI,
  eventName: "RefundRequested",
  onLogs: async (logs) => {
    for (const log of logs) {
      const args = log.args as any;
      if (!args.paymentInfo || args.nonce === undefined) continue;

      // Only respond to disputes targeting this merchant
      if (args.receiver?.toLowerCase() !== account.address.toLowerCase())
        continue;

      const key = `${log.transactionHash}-${args.nonce}`;
      if (processed.has(key)) continue;
      processed.add(key);

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

      console.log(
        `\n[${new Date().toISOString()}] Refund requested by ${args.payer} (nonce: ${nonce})`,
      );

      try {
        const evidence = JSON.stringify({
          type: "merchant-response",
          message:
            "Service was delivered as described. The API endpoint returned valid weather data.",
          serviceDelivered: true,
          endpoint: "/weather",
          timestamp: new Date().toISOString(),
        });

        const { txHash } = await merchant.submitEvidence(
          paymentInfo,
          nonce,
          evidence,
        );
        console.log(`[${new Date().toISOString()}] Evidence submitted: ${txHash}`);
      } catch (err) {
        console.error(`[${new Date().toISOString()}] Failed to submit evidence:`, err);
      }
    }
  },
});
