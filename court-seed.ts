/**
 * Seed Script for Court UI Testing
 *
 * Performs on-chain payment, dispute, and evidence submission so you can
 * watch it appear live in the arbiter dashboard.
 *
 * Uses only @x402r/* packages and viem — no cross-repo file imports.
 *
 * Usage:
 *   # Step 1: Deploy operator (first run only)
 *   PRIVATE_KEY=0x... pnpm seed
 *   # → deploys operator, prints OPERATOR_ADDRESS for arbiter startup
 *
 *   # Step 2: Start arbiter separately (local or EigenCloud)
 *   PRIVATE_KEY=0x... OPERATOR_ADDRESS=0x... pnpm dev
 *
 *   # Step 3: Re-run seed with existing operator + arbiter
 *   PRIVATE_KEY=0x... OPERATOR_ADDRESS=0x... ARBITER_URL=http://localhost:3000 pnpm seed
 *
 * Env vars:
 *   PRIVATE_KEY      — Required. Arbiter account (has EigenAI grant).
 *   OPERATOR_ADDRESS — Optional. Skip deployment if already deployed.
 *   ARBITER_URL      — Optional. Arbiter server URL for evaluation trigger.
 *   MNEMONIC         — Optional. Override auto-generated mnemonic.
 *   NETWORK_ID       — Optional. Default: eip155:84532 (Base Sepolia).
 *   RPC_URL          — Optional. Override default RPC.
 *   FACILITATOR_URL  — Optional. Remote facilitator (e.g. https://facilitator.ultravioletadao.xyz).
 *   PINATA_JWT       — Optional. Pin evidence to IPFS (falls back to inline JSON).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  erc20Abi,
  formatEther,
  formatUnits,
  publicActions,
  type Address,
  type PublicClient,
} from "viem";
import { baseSepolia, sepolia } from "viem/chains";
import type { Chain } from "viem";
import { mnemonicToAccount, privateKeyToAccount, generateMnemonic } from "viem/accounts";
import { english } from "viem/accounts";
import {
  deployMarketplaceOperator,
  getNetworkConfig,
  resolveAddresses,
  computePaymentInfoHash,
  toPaymentInfo,
  toFacilitatorEvmSigner,
  createInProcessFacilitator,
  type PaymentInfo,
} from "@x402r/core";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { X402rClient } from "@x402r/client";
import { X402rMerchant } from "@x402r/merchant";
import { refundable } from "@x402r/helpers";
import { x402Facilitator } from "@x402/core/facilitator";
import {
  x402ResourceServer,
  x402HTTPResourceServer,
  type HTTPResponseInstructions,
} from "@x402/core/server";
import { x402HTTPClient } from "@x402/core/http";
import { x402Client } from "@x402/core/client";
import { registerEscrowScheme as registerEscrowClientScheme } from "@x402r/evm/escrow/client";
import { registerEscrowScheme as registerEscrowFacilitatorScheme } from "@x402r/evm/escrow/facilitator";
import { registerEscrowServerScheme } from "@x402r/evm/escrow/server";
import { isEscrowPayload } from "@x402r/evm/escrow/types";
import type { EscrowPayload } from "@x402r/evm/escrow/types";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { savePaymentState } from "./cli/src/state.js";

// ============ Config Constants ============

const NETWORK_ID = process.env.NETWORK_ID ?? "eip155:84532";
const PAYMENT_AMOUNT = 10000n; // 0.01 USDC (6 decimals)

const GAS_FUNDING_BY_NETWORK: Record<string, bigint> = {
  "eip155:84532": 10000000000000n, // 0.00001 ETH (Base Sepolia — L2)
  "eip155:11155111": 10000000000000000n, // 0.01 ETH (Ethereum Sepolia — L1)
};
const GAS_FUNDING = GAS_FUNDING_BY_NETWORK[NETWORK_ID] ?? 10000000000000000n;

const CHAIN_CONFIGS: Record<string, { chain: Chain; usdc: Address; scanner: string }> = {
  "eip155:84532": {
    chain: baseSepolia,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address,
    scanner: "https://sepolia.basescan.org",
  },
  "eip155:11155111": {
    chain: sepolia,
    usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address,
    scanner: "https://sepolia.etherscan.io",
  },
};

const chainConfig = CHAIN_CONFIGS[NETWORK_ID];
if (!chainConfig) {
  console.error(
    `Unsupported NETWORK_ID: ${NETWORK_ID}. Supported: ${Object.keys(CHAIN_CONFIGS).join(", ")}`,
  );
  process.exit(1);
}

const CHAIN = chainConfig.chain;
const RPC_URL = process.env.RPC_URL ?? "https://sepolia.base.org";
const USDC_ADDRESS = chainConfig.usdc;
const ARBITER_URL = process.env.ARBITER_URL; // e.g. http://localhost:3000 or EigenCloud URL
const FACILITATOR_URL = process.env.FACILITATOR_URL; // e.g. https://facilitator.ultravioletadao.xyz

// ============ Environment ============

const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}` | undefined;

if (!PRIVATE_KEY) {
  console.error("Error: PRIVATE_KEY environment variable is required");
  console.error("Usage: PRIVATE_KEY=0x... pnpm seed");
  process.exit(1);
}

// Generate a unique mnemonic on first run, persist it for address stability.
const MNEMONIC_PATH = path.join(os.homedir(), ".x402r", "seed-mnemonic");
function getOrCreateMnemonic(): string {
  if (process.env.MNEMONIC) return process.env.MNEMONIC;
  try {
    return fs.readFileSync(MNEMONIC_PATH, "utf-8").trim();
  } catch {
    const m = generateMnemonic(english);
    fs.mkdirSync(path.dirname(MNEMONIC_PATH), { recursive: true });
    fs.writeFileSync(MNEMONIC_PATH, m, "utf-8");
    console.log(`Generated new mnemonic → ${MNEMONIC_PATH}`);
    return m;
  }
}
const MNEMONIC = getOrCreateMnemonic();

// ============ Helpers ============

function log(msg: string): void {
  console.log(`  ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForTx(publicClient: PublicClient, hash: `0x${string}`) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== "success") {
    throw new Error(`Transaction reverted: ${hash}`);
  }
  await sleep(2000);
  return receipt;
}

/** Serialize PaymentInfo bigint fields to strings for JSON output */
function serializePaymentInfo(pi: PaymentInfo): Record<string, unknown> {
  return {
    ...pi,
    maxAmount: pi.maxAmount.toString(),
    preApprovalExpiry: pi.preApprovalExpiry.toString(),
    authorizationExpiry: pi.authorizationExpiry.toString(),
    refundExpiry: pi.refundExpiry.toString(),
    salt: pi.salt.toString(),
  };
}

/**
 * Pin JSON to IPFS via Pinata.
 * Falls back to inline JSON if no credentials are configured.
 */
async function pinToIpfs(data: Record<string, unknown>): Promise<string> {
  const apiKey = process.env.PINATA_API_KEY;
  const secretKey = process.env.PINATA_SECRET_KEY;
  const jwt = process.env.PINATA_JWT;

  if (!jwt && !apiKey) {
    return JSON.stringify(data);
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (jwt) {
    headers.Authorization = `Bearer ${jwt}`;
  } else if (apiKey && secretKey) {
    headers.pinata_api_key = apiKey;
    headers.pinata_secret_api_key = secretKey;
  } else {
    console.warn("  PINATA_API_KEY requires PINATA_SECRET_KEY — falling back to inline");
    return JSON.stringify(data);
  }

  const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers,
    body: JSON.stringify({ pinataContent: data }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.warn(`  Pinata failed (${res.status}): ${text}`);
    return JSON.stringify(data);
  }

  const { IpfsHash } = (await res.json()) as { IpfsHash: string };
  return IpfsHash;
}

/**
 * Wrapper that catches "replacement transaction underpriced" and waits for
 * the pending txs to mine before retrying.
 */
async function withMempoolWait<T>(
  fn: () => Promise<T>,
  publicClient: PublicClient,
  address: Address,
  maxWaitMinutes = 10,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("replacement transaction underpriced") && !msg.includes("nonce too low")) {
        throw err;
      }

      const startNonce = await publicClient.getTransactionCount({ address, blockTag: "latest" });
      log(
        `Pending txs blocking nonce ${startNonce}. Waiting for them to mine (attempt ${attempt + 1}/3)...`,
      );

      const deadline = Date.now() + maxWaitMinutes * 60_000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 5000));
        const current = await publicClient.getTransactionCount({ address, blockTag: "latest" });
        if (current > startNonce) {
          log(`Nonce advanced to ${current}. Retrying...`);
          break;
        }
      }

      const finalNonce = await publicClient.getTransactionCount({ address, blockTag: "latest" });
      if (finalNonce === startNonce) {
        throw new Error(
          `Nonce ${startNonce} stuck for ${maxWaitMinutes} minutes. ` +
            `Wait a few minutes and retry, or use a fresh account.`,
        );
      }
    }
  }
  return await fn();
}

// ============ Main ============

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log(`║         Court UI Seed — ${CHAIN.name.padEnd(31)}║`);
  console.log("╚══════════════════════════════════════════════════════════╝");

  // ======== Phase 1: Setup Accounts ========

  console.log("\n── Phase 1: Setup Accounts ──\n");

  // Role mapping:
  //   PRIVATE_KEY → arbiter (has EigenAI grant)
  //   Mnemonic index 0 → payer (user funds with ETH + USDC)
  //   Mnemonic index 1 → merchant (payer auto-funds with ETH)
  const arbiterAccount = privateKeyToAccount(PRIVATE_KEY!);
  const payerAccount = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
  const merchantAccount = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });

  const publicClient = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) });

  const payerWallet = createWalletClient({
    account: payerAccount,
    chain: CHAIN,
    transport: http(RPC_URL),
  });
  const merchantWallet = createWalletClient({
    account: merchantAccount,
    chain: CHAIN,
    transport: http(RPC_URL),
  });
  const arbiterWallet = createWalletClient({
    account: arbiterAccount,
    chain: CHAIN,
    transport: http(RPC_URL),
  });

  log(`Arbiter:  ${arbiterAccount.address} (PRIVATE_KEY)`);
  log(`Payer:    ${payerAccount.address} (mnemonic[0])`);
  log(`Merchant: ${merchantAccount.address} (mnemonic[1])`);

  // Bootstrap payer from arbiter if needed
  const payerEth = await publicClient.getBalance({ address: payerAccount.address });
  const payerUsdc = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [payerAccount.address],
  });
  const arbiterEth = await publicClient.getBalance({ address: arbiterAccount.address });
  const arbiterUsdc = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [arbiterAccount.address],
  });

  log(`Arbiter:  ${formatEther(arbiterEth)} ETH / ${formatUnits(arbiterUsdc, 6)} USDC`);
  log(`Payer:    ${formatEther(payerEth)} ETH / ${formatUnits(payerUsdc, 6)} USDC`);

  const minPayerEth = GAS_FUNDING * 5n;
  if (payerEth < minPayerEth && arbiterEth > minPayerEth * 2n) {
    log("Bootstrapping payer with ETH from arbiter...");
    const ethTx = await arbiterWallet.sendTransaction({
      to: payerAccount.address,
      value: minPayerEth,
      chain: CHAIN,
      account: arbiterAccount,
    });
    await waitForTx(publicClient, ethTx);
    log(`  Sent ${formatEther(minPayerEth)} ETH to payer`);
  }

  if (payerUsdc < PAYMENT_AMOUNT && arbiterUsdc >= PAYMENT_AMOUNT) {
    log("Bootstrapping payer with USDC from arbiter...");
    const usdcTx = await arbiterWallet.writeContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: "transfer",
      args: [payerAccount.address, PAYMENT_AMOUNT],
      chain: CHAIN,
      account: arbiterAccount,
    });
    await waitForTx(publicClient, usdcTx);
    log(`  Sent ${formatUnits(PAYMENT_AMOUNT, 6)} USDC to payer`);
  }

  // Fund merchant from payer
  const merchantBal = await publicClient.getBalance({ address: merchantAccount.address });
  if (merchantBal < GAS_FUNDING) {
    await withMempoolWait(
      async () => {
        const currentBal = await publicClient.getBalance({ address: merchantAccount.address });
        if (currentBal >= GAS_FUNDING) {
          log("Funding tx from previous run confirmed — skipping.");
          return;
        }
        log("Funding merchant with ETH for gas...");
        const fundTx = await payerWallet.sendTransaction({
          to: merchantAccount.address,
          value: GAS_FUNDING,
          chain: CHAIN,
          account: payerAccount,
        });
        await waitForTx(publicClient, fundTx);
        log(`  Funded merchant: ${fundTx}`);
      },
      publicClient,
      payerAccount.address,
    );
  } else {
    log("Merchant already funded — skipping.");
  }
  log("Accounts ready");

  // ======== Phase 2: Deploy Operator ========

  console.log("\n── Phase 2: Deploy Operator ──\n");

  let operatorAddress: string;

  if (process.env.OPERATOR_ADDRESS) {
    operatorAddress = process.env.OPERATOR_ADDRESS;
    log(`Using existing operator: ${operatorAddress}`);
  } else {
    const deployResult = await withMempoolWait(
      () =>
        deployMarketplaceOperator(payerWallet, publicClient, NETWORK_ID, {
          feeRecipient: payerAccount.address,
          arbiter: arbiterAccount.address,
          escrowPeriodSeconds: 604800n,
          freezeDurationSeconds: 259200n,
          operatorFeeBps: 100n,
        }),
      publicClient,
      payerAccount.address,
    );

    operatorAddress = deployResult.operatorAddress;
    log(`Deployed operator: ${operatorAddress}`);
    log(`  ${deployResult.summary.newDeployments} new, ${deployResult.summary.existingContracts} existing`);
  }

  // If no arbiter URL, print startup instructions and exit
  if (!ARBITER_URL) {
    console.log("\n╔══════════════════════════════════════════════════════════╗");
    console.log("║              OPERATOR DEPLOYED — START ARBITER          ║");
    console.log("╚══════════════════════════════════════════════════════════╝");
    console.log("\n  Add to your .env:");
    console.log(`  OPERATOR_ADDRESS=${operatorAddress}`);
    console.log(`  DEFAULT_RECEIVER=${merchantAccount.address}`);
    console.log("\n  Then start the arbiter + dashboard:\n");
    console.log("  # Terminal 1: Arbiter server");
    console.log("  pnpm dev\n");
    console.log("  # Terminal 2: Dashboard");
    console.log("  pnpm dashboard\n");
    console.log("  # Terminal 3: Run seed");
    console.log("  ARBITER_URL=http://localhost:3000 pnpm seed\n");
    console.log("  # Or with EigenCloud arbiter:");
    console.log("  ARBITER_URL=https://your-arbiter.eigencloud.io pnpm seed\n");
    process.exit(0);
  }

  // Verify arbiter is reachable
  log(`Checking arbiter at ${ARBITER_URL}...`);
  try {
    const healthRes = await fetch(`${ARBITER_URL}/health`);
    if (!healthRes.ok) {
      throw new Error(`Health check returned ${healthRes.status}`);
    }
    log(`Arbiter is live at ${ARBITER_URL}`);
  } catch (err) {
    console.error(`\nError: Arbiter not reachable at ${ARBITER_URL}`);
    console.error(`  ${err instanceof Error ? err.message : err}`);
    console.error("\n  Make sure the arbiter is running before running seed.");
    process.exit(1);
  }

  // ======== Phase 3: HTTP 402 Payment ========

  console.log("\n── Phase 3: HTTP 402 Payment ──\n");

  // Facilitator — remote HTTP or in-process fallback
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let facilitatorClient: any;
  if (FACILITATOR_URL) {
    log(`Using remote facilitator: ${FACILITATOR_URL}`);
    facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
  } else {
    log("Using in-process facilitator (payer wallet as signer)");
    const facilitatorViemClient = createWalletClient({
      account: payerAccount,
      chain: CHAIN,
      transport: http(RPC_URL),
    }).extend(publicActions);

    const signer = toFacilitatorEvmSigner(facilitatorViemClient);
    const { client } = createInProcessFacilitator(new x402Facilitator(), fac =>
      registerEscrowFacilitatorScheme(fac, {
        signer: signer as Parameters<typeof registerEscrowFacilitatorScheme>[1]["signer"],
        networks: NETWORK_ID,
      }),
    );
    facilitatorClient = client;
  }

  const resourceServer = new x402ResourceServer(facilitatorClient);
  registerEscrowServerScheme(resourceServer, { networks: NETWORK_ID });
  await resourceServer.initialize();

  const routes = {
    "/api/weather": {
      accepts: refundable(
        {
          scheme: "escrow",
          network: NETWORK_ID,
          payTo: merchantAccount.address,
          price: "$0.01",
        },
        operatorAddress as `0x${string}`,
        { maxFeeBps: 10000 },
      ),
      description: "Weather API (seed test)",
      mimeType: "application/json",
    },
  };
  const httpServer = new x402HTTPResourceServer(resourceServer, routes);
  await httpServer.initialize();

  const paymentClient = new x402Client();
  registerEscrowClientScheme(paymentClient, {
    signer: payerAccount,
    networks: NETWORK_ID,
  });
  const httpClient = new x402HTTPClient(paymentClient);

  // Unpaid request → 402
  const unpaidContext = {
    adapter: {
      getHeader: (_name: string) => undefined,
      getMethod: () => "GET",
      getPath: () => "/api/weather",
      getUrl: () => "https://e2e-test.local/api/weather",
      getAcceptHeader: () => "application/json",
      getUserAgent: () => "x402r-seed/1.0",
    },
    path: "/api/weather",
    method: "GET",
  };

  const unpaidResult = await httpServer.processHTTPRequest(unpaidContext);
  if (unpaidResult.type !== "payment-error") {
    throw new Error(`Expected payment-error, got ${unpaidResult.type}`);
  }
  const initial402 = (unpaidResult as { type: "payment-error"; response: HTTPResponseInstructions })
    .response;
  if (initial402.status !== 402) {
    throw new Error(`Expected 402 status, got ${initial402.status}`);
  }
  log("Unpaid request returns 402");

  const paymentRequired = httpClient.getPaymentRequiredResponse(
    name => initial402.headers[name],
    initial402.body,
  );
  const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
  const requestHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);
  log("Payment payload created");

  // Paid request → verify + settle
  const paidContext = {
    adapter: {
      getHeader: (name: string) =>
        requestHeaders[name] ?? requestHeaders[name.toUpperCase()] ?? undefined,
      getMethod: () => "GET",
      getPath: () => "/api/weather",
      getUrl: () => "https://e2e-test.local/api/weather",
      getAcceptHeader: () => "application/json",
      getUserAgent: () => "x402r-seed/1.0",
    },
    path: "/api/weather",
    method: "GET",
  };

  const paidResult = await httpServer.processHTTPRequest(paidContext);
  if (paidResult.type !== "payment-verified") {
    const errMsg =
      paidResult.type === "payment-error"
        ? JSON.stringify((paidResult as { response: HTTPResponseInstructions }).response)
        : paidResult.type;
    throw new Error(`Expected payment-verified, got: ${errMsg}`);
  }
  log("Payment verified");

  const { paymentPayload: verifiedPayload, paymentRequirements: verifiedRequirements } =
    paidResult as {
      type: "payment-verified";
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };

  const settlementResult = await httpServer.processSettlement(
    verifiedPayload,
    verifiedRequirements,
  );
  if (!settlementResult.success) {
    throw new Error(`Settlement failed: ${settlementResult.errorReason}`);
  }
  await waitForTx(publicClient, settlementResult.transaction as `0x${string}`);
  log(`Settled on-chain: ${settlementResult.transaction}`);

  // Extract PaymentInfo
  if (!isEscrowPayload(verifiedPayload.payload)) {
    throw new Error("Verified payload is not an EscrowPayload");
  }
  const paymentInfo = toPaymentInfo(verifiedPayload.payload as EscrowPayload);
  const networkConfig = getNetworkConfig(NETWORK_ID)!;
  const escrowHash = computePaymentInfoHash(
    networkConfig.chainId,
    networkConfig.authCaptureEscrow as Address,
    paymentInfo,
  );

  savePaymentState({
    paymentInfo,
    operatorAddress,
    paymentHash: escrowHash,
    timestamp: new Date().toISOString(),
    networkId: NETWORK_ID,
  });
  log("Payment state saved to ~/.x402r/last-payment.json");

  // ======== Phase 4: Create Dispute + Evidence ========

  console.log("\n── Phase 4: Create Dispute + Evidence ──\n");

  log("Waiting for RPC state propagation...");
  await sleep(5000);

  const addresses = resolveAddresses(NETWORK_ID);
  const opAddr = operatorAddress as Address;

  const client = new X402rClient({
    publicClient,
    walletClient: payerWallet,
    operatorAddress: opAddr,
    escrowAddress: addresses.escrowAddress,
    refundRequestAddress: addresses.refundRequestAddress,
    refundRequestEvidenceAddress: addresses.evidenceAddress,
    chainId: addresses.chainId,
  });

  const merchant = new X402rMerchant({
    publicClient,
    walletClient: merchantWallet,
    operatorAddress: opAddr,
    escrowAddress: addresses.escrowAddress,
    refundRequestAddress: addresses.refundRequestAddress,
    refundRequestEvidenceAddress: addresses.evidenceAddress,
    chainId: addresses.chainId,
  });

  // Request refund
  const { txHash: refundTx } = await withMempoolWait(
    () => client.requestRefund(paymentInfo, PAYMENT_AMOUNT, 0n),
    publicClient,
    payerAccount.address,
  );
  await waitForTx(publicClient, refundTx);
  log(`Refund requested: ${refundTx}`);

  // Payer evidence
  const payerCid = await pinToIpfs({
    type: "payer-refund-request",
    reason: "API returned stale weather data despite payment",
    description:
      "I paid 0.01 USDC for real-time weather data via the /api/weather endpoint. " +
      "The response included a 'last_updated' timestamp of 2026-02-17T03:00:00Z, " +
      "which was over 15 hours old at the time of my request (2026-02-18T18:32:00Z). " +
      "The API documentation promises data no older than 5 minutes. " +
      "I immediately re-queried a free alternative and confirmed current conditions " +
      "differed significantly (the paid API showed 'clear skies' while it was actively raining).",
    requestTimestamp: "2026-02-18T18:32:00Z",
    endpoint: "GET /api/weather?lat=37.7749&lon=-122.4194",
    responseSnippet: {
      last_updated: "2026-02-17T03:00:00Z",
      condition: "clear",
      temp_f: 68,
    },
    expectedBehavior: "Real-time data updated within 5 minutes per service SLA",
  });
  log(`Payer evidence CID: ${payerCid.slice(0, 40)}...`);
  const { txHash: payerEvidenceTx } = await withMempoolWait(
    () => client.submitEvidence(paymentInfo, 0n, payerCid),
    publicClient,
    payerAccount.address,
  );
  await waitForTx(publicClient, payerEvidenceTx);
  log(`Payer evidence submitted: ${payerEvidenceTx}`);

  // Top up merchant gas if needed
  const EVIDENCE_GAS = 30000000000000000n; // 0.03 ETH
  const merchantBalAfter = await publicClient.getBalance({ address: merchantAccount.address });
  if (merchantBalAfter < EVIDENCE_GAS) {
    log("Topping up merchant for evidence tx...");
    const topUpTx = await payerWallet.sendTransaction({
      to: merchantAccount.address,
      value: EVIDENCE_GAS,
      chain: CHAIN,
      account: payerAccount,
    });
    await waitForTx(publicClient, topUpTx);
  }

  // Merchant evidence
  const merchantCid = await pinToIpfs({
    type: "merchant-response",
    response: "API was functioning correctly — stale timestamp was a display bug, not a data issue",
    description:
      "Our weather data pipeline was operational at the time of the request. " +
      "The 'last_updated' field the payer references is a known UI-layer bug (tracked as WEATHER-4821) " +
      "where the formatted timestamp reflects the cache partition creation time rather than " +
      "the most recent data refresh. The actual sensor readings returned were current — " +
      "our ingestion logs confirm a fresh pull from NOAA at 2026-02-18T18:30:12Z, " +
      "two minutes before the payer's request. " +
      "The discrepancy between 'clear skies' and rain is plausible: the queried coordinates " +
      "(37.7749, -122.4194) are downtown SF, and our station covers a 10km radius. " +
      "Microclimates in SF frequently produce sun/rain within blocks. " +
      "We have since patched the timestamp display (deployed 2026-02-18T20:15:00Z).",
    ingestionLog: {
      source: "NOAA ISD",
      lastPull: "2026-02-18T18:30:12Z",
      stationId: "KSFO",
      recordsIngested: 47,
    },
    bugTicket: "WEATHER-4821",
    patchDeployed: "2026-02-18T20:15:00Z",
  });
  log(`Merchant evidence CID: ${merchantCid.slice(0, 40)}...`);
  const { txHash: merchantEvidenceTx } = await withMempoolWait(
    () => merchant.submitEvidence(paymentInfo, 0n, merchantCid),
    publicClient,
    merchantAccount.address,
  );
  await waitForTx(publicClient, merchantEvidenceTx);
  log(`Merchant evidence submitted: ${merchantEvidenceTx}`);

  // ======== Phase 5: Trigger Arbiter Evaluation ========

  console.log("\n── Phase 5: Trigger Arbiter Evaluation ──\n");

  log("Triggering AI evaluation...");
  try {
    const evalRes = await fetch(`${ARBITER_URL}/api/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentInfo: serializePaymentInfo(paymentInfo),
        nonce: 0,
      }),
    });
    if (evalRes.ok) {
      const evalData = (await evalRes.json()) as {
        decision: string;
        confidence: number;
        decisionTx?: string;
      };
      log(`AI decision: ${evalData.decision} (confidence: ${evalData.confidence})`);
      if (evalData.decisionTx) {
        log(`  Decision tx: ${evalData.decisionTx}`);
      }
    } else {
      const errText = await evalRes.text();
      log(`Evaluation returned ${evalRes.status}: ${errText}`);
    }
  } catch (err) {
    log(`Evaluation failed: ${err}`);
  }

  // ======== Done ========

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║                    SEED COMPLETE                        ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  console.log("\n  Operator address:", operatorAddress);
  console.log("  Arbiter address: ", arbiterAccount.address);
  console.log("  Merchant address:", merchantAccount.address);
  console.log("  Payer address:   ", payerAccount.address);
  console.log("  Network:         ", `${CHAIN.name} (${NETWORK_ID})`);
  console.log("  Arbiter URL:     ", ARBITER_URL);
  if (FACILITATOR_URL) console.log("  Facilitator URL: ", FACILITATOR_URL);
  console.log("  Dashboard:       ", "http://localhost:3001");

  console.log("\n  PaymentInfo JSON:");
  console.log("  ─────────────────────────────────────────");
  console.log(JSON.stringify(serializePaymentInfo(paymentInfo), null, 2));
}

main().catch(error => {
  console.error("\nSeed script failed:", error);
  process.exit(1);
});
