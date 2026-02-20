/**
 * x402r Facilitator Server
 *
 * Verifies and settles escrow payments on-chain. Required by the merchant
 * server's payment middleware to process x402r payments.
 *
 * Usage: pnpm facilitator
 *
 * Env:
 *   PRIVATE_KEY            — Facilitator wallet (needs ETH for gas)
 *   CHAIN_ID               — Chain (default: 84532)
 *   RPC_URL                — Optional custom RPC
 *   FACILITATOR_PORT       — Server port (default: 4022)
 */

import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import {
  createWalletClient,
  http,
  publicActions,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, base, sepolia } from "viem/chains";
import { x402Facilitator } from "@x402/core/facilitator";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { registerEscrowScheme } from "@x402r/evm/escrow/facilitator";

dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}` | undefined;
const CHAIN_ID = parseInt(process.env.CHAIN_ID ?? "84532", 10);
const RPC_URL = process.env.RPC_URL;
const PORT = parseInt(process.env.FACILITATOR_PORT ?? process.env.PORT ?? "4022", 10);

if (!PRIVATE_KEY) {
  console.error("PRIVATE_KEY environment variable is required");
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
const account = privateKeyToAccount(PRIVATE_KEY);
const transport = http(RPC_URL);

const viemClient = createWalletClient({
  account,
  chain,
  transport,
}).extend(publicActions);

const evmSigner = toFacilitatorEvmSigner({
  getCode: (args: { address: `0x${string}` }) => viemClient.getCode(args),
  address: account.address,
  readContract: (args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }) =>
    viemClient.readContract({
      ...args,
      args: args.args || [],
    }),
  verifyTypedData: (args: {
    address: `0x${string}`;
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
    signature: `0x${string}`;
  }) => viemClient.verifyTypedData(args as any),
  writeContract: (args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }) =>
    viemClient.writeContract({
      ...args,
      args: args.args || [],
    }),
  sendTransaction: (args: { to: `0x${string}`; data: `0x${string}` }) =>
    viemClient.sendTransaction(args),
  waitForTransactionReceipt: (args: { hash: `0x${string}` }) =>
    viemClient.waitForTransactionReceipt(args),
});

const facilitator = new x402Facilitator();

registerEscrowScheme(facilitator, {
  signer: evmSigner,
  networks: networkId,
});

const app = express();
app.use(cors());
app.use(express.json());

app.get("/supported", (_req, res) => {
  try {
    res.json(facilitator.getSupported());
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.post("/verify", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body as {
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };

    if (!paymentPayload || !paymentRequirements) {
      res.status(400).json({ error: "Missing paymentPayload or paymentRequirements" });
      return;
    }

    const response: VerifyResponse = await facilitator.verify(
      paymentPayload,
      paymentRequirements,
    );
    res.json(response);
  } catch (error) {
    console.error("Verify error:", error);
    res.status(500).json({ error: String(error) });
  }
});

app.post("/settle", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;

    if (!paymentPayload || !paymentRequirements) {
      res.status(400).json({ error: "Missing paymentPayload or paymentRequirements" });
      return;
    }

    const response: SettleResponse = await facilitator.settle(
      paymentPayload as PaymentPayload,
      paymentRequirements as PaymentRequirements,
    );
    res.json(response);
  } catch (error) {
    console.error("Settle error:", error);
    res.status(500).json({ error: String(error) });
  }
});

app.listen(PORT, () => {
  console.log(`x402r Facilitator listening on http://localhost:${PORT}`);
  console.log(`  Address: ${account.address}`);
  console.log(`  Network: ${networkId} (${chain.name})`);
});
