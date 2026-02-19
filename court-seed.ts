/**
 * Seed Script for Court UI Testing
 *
 * Creates on-chain disputes with evidence so the court-ui dashboard has data to display.
 * Lighter than the full cli:e2e test — runs the on-chain setup, then spawns services.
 *
 * Usage:
 *   PRIVATE_KEY=0x... npm run seed
 *
 * Prerequisites:
 *   - Testnet ETH on the PRIVATE_KEY account (arbiter + EigenAI grant)
 *   - Testnet ETH + USDC on the mnemonic payer account (index 0)
 *   - Set NETWORK_ID in .env (default: eip155:84532 / Base Sepolia)
 *   - Run `pnpm install` in x402r-sdk/ first
 */

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  createPublicClient,
  createWalletClient,
  http,
  erc20Abi,
  formatEther,
  formatUnits,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount, generateMnemonic } from "viem/accounts";
import { english } from "viem/accounts";
import { getNetworkConfig, resolveAddresses } from "@x402r/core";
import {
  StepRunner,
  NETWORK_ID,
  CHAIN,
  RPC_URL,
  PAYMENT_AMOUNT,
  GAS_FUNDING,
  USDC_ADDRESS,
  checkAndLogBalances,
  deployTestOperator,
  setupHTTP402,
  performHTTP402Payment,
  createSDKInstances,
  waitForTx,
  type E2EAccounts,
  type PaymentInfo,
} from "../x402r-sdk/examples/e2e-test/shared.js";
import { savePaymentState } from "./cli/src/state.js";

// ============ Paths ============

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = __dirname;

// ============ Environment ============

const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}` | undefined;

if (!PRIVATE_KEY) {
  console.error("Error: PRIVATE_KEY environment variable is required");
  console.error("Usage: PRIVATE_KEY=0x... npm run seed");
  process.exit(1);
}

// Generate a unique mnemonic on first run, persist it for address stability.
// The Hardhat default mnemonic is publicly known — other users drain those accounts on testnets.
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

/** Serialize PaymentInfo bigint fields to strings for JSON output and API calls */
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
 * Supports both legacy key pair (PINATA_API_KEY + PINATA_SECRET_KEY)
 * and JWT/V3 token (PINATA_JWT). Falls back to inline JSON.
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

/** Poll a URL until it returns 200, with retries */
async function pollHealth(url: string, maxAttempts = 30): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // Server not ready yet
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

/**
 * Wrapper that catches "replacement transaction underpriced" and waits for
 * the pending txs to mine before retrying. Does NOT send cancel txs —
 * that makes things worse by creating more pending txs with high gas.
 */
async function withMempoolWait<T>(
  fn: () => Promise<T>,
  accounts: E2EAccounts,
  runner: { log: (msg: string) => void },
  maxWaitMinutes = 10,
): Promise<T> {
  const { publicClient, payerAccount } = accounts;
  const addr = payerAccount.address;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("replacement transaction underpriced") && !msg.includes("nonce too low")) {
        throw err;
      }

      const startNonce = await publicClient.getTransactionCount({ address: addr, blockTag: "latest" });
      runner.log(`Pending txs blocking nonce ${startNonce}. Waiting for them to mine (attempt ${attempt + 1}/3)...`);

      // Poll until nonce advances (meaning the blocking tx mined)
      const deadline = Date.now() + maxWaitMinutes * 60_000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 5000));
        const current = await publicClient.getTransactionCount({ address: addr, blockTag: "latest" });
        if (current > startNonce) {
          runner.log(`Nonce advanced to ${current}. Retrying...`);
          break;
        }
        // Log progress every 30 seconds
        if (Math.floor((Date.now() - deadline + maxWaitMinutes * 60_000) / 30_000) % 1 === 0) {
          const elapsed = Math.floor((Date.now() - (deadline - maxWaitMinutes * 60_000)) / 1000);
          if (elapsed % 30 === 0 && elapsed > 0) {
            runner.log(`  Still waiting... nonce=${current} (${elapsed}s elapsed)`);
          }
        }
      }

      const finalNonce = await publicClient.getTransactionCount({ address: addr, blockTag: "latest" });
      if (finalNonce === startNonce) {
        throw new Error(
          `Nonce ${startNonce} stuck for ${maxWaitMinutes} minutes. ` +
          `Previous cancel txs may be blocking. Wait a few minutes and retry, ` +
          `or use a fresh account.`,
        );
      }
    }
  }
  // Should not reach here, but satisfy TypeScript
  return await fn();
}

// ============ Account Setup ============

/**
 * Set up accounts:
 *   PRIVATE_KEY → arbiter (has EigenAI grant)
 *   Mnemonic index 0 → payer (user funds with ETH + USDC)
 *   Mnemonic index 1 → merchant (payer auto-funds with ETH)
 */
async function setupAccounts(): Promise<E2EAccounts> {
  const arbiterAccount = privateKeyToAccount(PRIVATE_KEY!);
  const payerAccount = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
  const merchantAccount = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });

  const publicClient = createPublicClient({
    chain: CHAIN,
    transport: http(RPC_URL),
  });

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

  const networkConfig = getNetworkConfig(NETWORK_ID)!;
  const addresses = resolveAddresses(NETWORK_ID);

  return {
    payerAccount,
    merchantAccount,
    arbiterAccount,
    publicClient,
    payerWallet,
    merchantWallet,
    arbiterWallet,
    networkConfig,
    addresses,
  };
}

// ============ Main ============

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log(`║         Court UI Seed — ${CHAIN.name.padEnd(31)}║`);
  console.log("╚══════════════════════════════════════════════════════════╝");

  const runner = new StepRunner();
  const children: ChildProcess[] = [];

  // Cleanup on exit
  const cleanup = () => {
    console.log("\nShutting down...");
    for (const child of children) {
      child.kill("SIGTERM");
    }
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // ======== Phase 1: On-chain Setup ========

  console.log("\n── Phase 1: On-chain Setup ──\n");

  // Step 1: Setup accounts
  runner.step("1. Setup Accounts");
  const accounts = await setupAccounts();
  runner.log(`Arbiter:  ${accounts.arbiterAccount!.address} (PRIVATE_KEY)`);
  runner.log(`Payer:    ${accounts.payerAccount.address} (mnemonic[0])`);
  runner.log(`Merchant: ${accounts.merchantAccount.address} (mnemonic[1])`);

  // Bootstrap payer from arbiter if needed (arbiter has ETH + USDC + EigenAI grant)
  const payerEth = await accounts.publicClient.getBalance({ address: accounts.payerAccount.address });
  const payerUsdc = await accounts.publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [accounts.payerAccount.address],
  });
  const arbiterEth = await accounts.publicClient.getBalance({ address: accounts.arbiterAccount!.address });
  const arbiterUsdc = await accounts.publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [accounts.arbiterAccount!.address],
  });

  runner.log(`Arbiter:  ${formatEther(arbiterEth)} ETH / ${formatUnits(arbiterUsdc, 6)} USDC`);
  runner.log(`Payer:    ${formatEther(payerEth)} ETH / ${formatUnits(payerUsdc, 6)} USDC`);

  // Fund payer ETH from arbiter if low
  const minPayerEth = GAS_FUNDING * 5n; // must match checkAndLogBalances threshold
  if (payerEth < minPayerEth && arbiterEth > minPayerEth * 2n) {
    runner.log("Bootstrapping payer with ETH from arbiter...");
    const ethTx = await accounts.arbiterWallet!.sendTransaction({
      to: accounts.payerAccount.address,
      value: minPayerEth,
      chain: CHAIN,
      account: accounts.arbiterAccount!,
    });
    await waitForTx(accounts.publicClient, ethTx);
    runner.log(`  Sent ${formatEther(minPayerEth)} ETH to payer`);
  }

  // Fund payer USDC from arbiter if low
  if (payerUsdc < PAYMENT_AMOUNT && arbiterUsdc >= PAYMENT_AMOUNT) {
    runner.log("Bootstrapping payer with USDC from arbiter...");
    const usdcTx = await accounts.arbiterWallet!.writeContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: "transfer",
      args: [accounts.payerAccount.address, PAYMENT_AMOUNT],
      chain: CHAIN,
      account: accounts.arbiterAccount!,
    });
    await waitForTx(accounts.publicClient, usdcTx);
    runner.log(`  Sent ${formatUnits(PAYMENT_AMOUNT, 6)} USDC to payer`);
  }

  await checkAndLogBalances(accounts, runner);

  // Only fund merchant from payer — arbiter is self-funded (PRIVATE_KEY)
  const MIN_BALANCE = GAS_FUNDING;
  const needsFunding = async () => {
    const mBal = await accounts.publicClient.getBalance({ address: accounts.merchantAccount.address });
    return mBal < MIN_BALANCE;
  };
  if (await needsFunding()) {
    await withMempoolWait(
      async () => {
        if (!(await needsFunding())) {
          runner.log("Funding tx from previous run confirmed — skipping.");
          return;
        }
        runner.log("Funding merchant with ETH for gas...");
        const fundTx = await accounts.payerWallet.sendTransaction({
          to: accounts.merchantAccount.address,
          value: GAS_FUNDING,
          chain: CHAIN,
          account: accounts.payerAccount,
        });
        await waitForTx(accounts.publicClient, fundTx);
        runner.log(`  Funded merchant: ${fundTx}`);
      },
      accounts,
      runner,
    );
  } else {
    runner.log("Merchant already funded — skipping.");
  }
  runner.pass("Setup accounts and fund derived wallets");

  // Step 2: Deploy operator
  runner.step("2. Deploy Marketplace Operator");
  const deployResult = await withMempoolWait(
    () => deployTestOperator(accounts, runner),
    accounts,
    runner,
  );
  const operatorAddress = deployResult.operatorAddress;

  // Step 3: Setup HTTP 402 infrastructure
  runner.step("3. Setup HTTP 402 Infrastructure");
  const infra = await setupHTTP402(accounts, operatorAddress);
  runner.pass("HTTP 402 infrastructure ready");

  // Step 4: Perform HTTP 402 payment
  runner.step("4. HTTP 402 Payment Flow");
  const { paymentInfo, escrowHash } = await withMempoolWait(
    () => performHTTP402Payment(infra, accounts, runner),
    accounts,
    runner,
  );

  // Step 5: Save payment state (for CLI compatibility)
  runner.step("5. Save Payment State");
  savePaymentState({
    paymentInfo,
    operatorAddress,
    paymentHash: escrowHash,
    timestamp: new Date().toISOString(),
    networkId: NETWORK_ID,
  });
  runner.pass("Payment state saved to ~/.x402r/last-payment.json");

  // Step 6: Create dispute (request refund)
  runner.step("6. Request Refund (Create Dispute)");
  // Wait for RPC nonce to catch up after rapid settlement txs
  runner.log("Waiting for RPC state propagation...");
  await new Promise(r => setTimeout(r, 5000));
  const { client, merchant, arbiter: arbiterSdk } = createSDKInstances(accounts, operatorAddress);
  const { txHash: refundTx } = await withMempoolWait(
    () => client.requestRefund(paymentInfo, PAYMENT_AMOUNT, 0n),
    accounts,
    runner,
  );
  await waitForTx(accounts.publicClient, refundTx);
  runner.pass("Refund request submitted (nonce=0)", refundTx);

  // Step 7: Submit payer evidence
  runner.step("7. Submit Payer Evidence");
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
  runner.log(`Evidence CID: ${payerCid}`);
  const { txHash: evidenceTx } = await withMempoolWait(
    () => client.submitEvidence(paymentInfo, 0n, payerCid),
    accounts,
    runner,
  );
  await waitForTx(accounts.publicClient, evidenceTx);
  runner.pass("Payer evidence submitted", evidenceTx);

  // Step 8: Submit merchant evidence
  runner.step("8. Submit Merchant Evidence");
  // Merchant gas is drained by settlement — top up from payer
  const EVIDENCE_GAS = 30000000000000000n; // 0.03 ETH — enough for submitEvidence on L1
  const merchantBal = await accounts.publicClient.getBalance({ address: accounts.merchantAccount.address });
  if (merchantBal < EVIDENCE_GAS) {
    runner.log(`Merchant balance: ${merchantBal} wei — topping up...`);
    const topUpTx = await accounts.payerWallet.sendTransaction({
      to: accounts.merchantAccount.address,
      value: EVIDENCE_GAS,
      chain: CHAIN,
      account: accounts.payerAccount,
    });
    await waitForTx(accounts.publicClient, topUpTx);
    runner.log("Merchant topped up");
  }
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
  runner.log(`Evidence CID: ${merchantCid}`);
  const { txHash: merchantEvidenceTx } = await withMempoolWait(
    () => merchant.submitEvidence(paymentInfo, 0n, merchantCid),
    accounts,
    runner,
  );
  await waitForTx(accounts.publicClient, merchantEvidenceTx);
  runner.pass("Merchant evidence submitted", merchantEvidenceTx);

  // ======== Phase 2: Start Services ========

  console.log("\n── Phase 2: Start Services ──\n");

  // Step 9: Start arbiter server
  runner.step("9. Start Arbiter Server");
  const arbiterProcess = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PRIVATE_KEY: PRIVATE_KEY!,
      OPERATOR_ADDRESS: operatorAddress,
      DEFAULT_RECEIVER: accounts.merchantAccount.address,
      PORT: "3000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(arbiterProcess);

  arbiterProcess.stdout?.on("data", (data: Buffer) => {
    process.stdout.write(`[arbiter] ${data}`);
  });
  arbiterProcess.stderr?.on("data", (data: Buffer) => {
    process.stderr.write(`[arbiter] ${data}`);
  });

  runner.log("Waiting for arbiter server...");
  const healthy = await pollHealth("http://localhost:3000/health");
  if (!healthy) {
    console.error("Error: Arbiter server did not start within 30 seconds");
    cleanup();
  }
  runner.pass("Arbiter server running on :3000");

  // Cache paymentInfo in the arbiter server so the dashboard can auto-load it
  runner.log("Caching paymentInfo in arbiter server...");
  await fetch("http://localhost:3000/api/payment-info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(serializePaymentInfo(paymentInfo)),
  });

  // Step 10: Trigger AI evaluation (optional — requires EigenAI access)
  runner.step("10. Trigger AI Evaluation (optional)");
  let evalSucceeded = false;
  try {
    const evalRes = await fetch("http://localhost:3000/api/evaluate", {
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
      runner.log(`Decision: ${evalData.decision} (confidence: ${evalData.confidence})`);
      if (evalData.decisionTx) {
        runner.log(`Decision tx: ${evalData.decisionTx}`);
        evalSucceeded = true;
      }
      runner.pass("AI evaluation completed");
    } else {
      const errText = await evalRes.text();
      runner.log(`Evaluation returned ${evalRes.status}: ${errText}`);
    }
  } catch (err) {
    runner.log(`Evaluation failed: ${err}`);
  }

  // Step 10b: Ensure on-chain ruling exists (fallback if evaluate didn't update status)
  if (!evalSucceeded && arbiterSdk) {
    runner.step("10b. Direct Ruling (fallback)");
    // Pick approve or deny randomly so the dashboard shows a mix
    const fallbackApprove = Math.random() > 0.5;
    const fallbackDecision = fallbackApprove ? "approve" : "deny";
    const fallbackConfidence = +(0.6 + Math.random() * 0.3).toFixed(2);

    // Submit arbiter evidence so the dashboard has something to show
    const fallbackEvidence = JSON.stringify({
      type: "arbiter-ruling",
      decision: fallbackDecision,
      reasoning: fallbackApprove
        ? "Based on the evidence provided, the payer's complaint about stale data is substantiated by the timestamp discrepancy. The merchant's bug explanation, while plausible, does not change the fact that the service SLA was not visibly met from the payer's perspective."
        : "The merchant provided credible evidence that the underlying data was fresh despite the display bug. The payer's complaint is based on a UI timestamp rather than actual data quality, and the weather discrepancy is explained by local micro-climate variation.",
      confidence: fallbackConfidence,
      commitment: { note: "Fallback ruling — EigenAI unavailable" },
      model: "fallback",
    });
    try {
      const { txHash: evidenceTx } = await arbiterSdk.submitEvidence(paymentInfo, 0n, fallbackEvidence);
      await waitForTx(accounts.publicClient, evidenceTx);
      runner.log("Arbiter evidence submitted");
    } catch (err) {
      runner.log(`Evidence submission failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Submit on-chain ruling
    try {
      if (fallbackApprove) {
        const { txHash: approveTx } = await arbiterSdk.approveRefundRequest(paymentInfo, 0n);
        await waitForTx(accounts.publicClient, approveTx);
        runner.pass(`Refund approved on-chain (fallback, confidence=${fallbackConfidence})`, approveTx);
      } else {
        const { txHash: denyTx } = await arbiterSdk.denyRefundRequest(paymentInfo, 0n);
        await waitForTx(accounts.publicClient, denyTx);
        runner.pass(`Refund denied on-chain (fallback, confidence=${fallbackConfidence})`, denyTx);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      runner.log(`Direct ruling failed: ${errMsg}`);
      runner.log("Status will remain PENDING — check arbiter authorization");
    }
  }

  // Step 11: Start dashboard
  runner.step("11. Start Dashboard");
  const dashboardProcess = spawn("npm", ["run", "dev"], {
    cwd: path.resolve(PROJECT_ROOT, "court-ui"),
    env: { ...process.env, NEXT_PUBLIC_ARBITER_URL: "http://localhost:3000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(dashboardProcess);

  dashboardProcess.stdout?.on("data", (data: Buffer) => {
    process.stdout.write(`[dashboard] ${data}`);
  });
  dashboardProcess.stderr?.on("data", (data: Buffer) => {
    process.stderr.write(`[dashboard] ${data}`);
  });

  // Give dashboard a moment to start
  await new Promise(r => setTimeout(r, 3000));
  runner.pass("Dashboard starting on :3001");

  // ======== Phase 3: Output ========

  console.log("\n── Phase 3: Ready ──\n");

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║                    SEED COMPLETE                        ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  console.log("\n  Operator address:", operatorAddress);
  console.log("  Arbiter address: ", accounts.arbiterAccount!.address);
  console.log("  Merchant address:", accounts.merchantAccount.address);
  console.log("  Payer address:   ", accounts.payerAccount.address);

  console.log("\n  PaymentInfo JSON (paste into dashboard):");
  console.log("  ─────────────────────────────────────────");
  console.log(JSON.stringify(serializePaymentInfo(paymentInfo), null, 2));

  console.log("\n  URLs:");
  console.log("  Arbiter health: http://localhost:3000/health");
  console.log("  Dashboard:      http://localhost:3001");

  console.log("\n  Press Ctrl+C to stop all services.\n");

  // Keep alive — child processes stay running until Ctrl+C
  await new Promise(() => {});
}

main().catch(error => {
  console.error("\nSeed script failed:", error);
  process.exit(1);
});
