/**
 * E2E Live Test: Full Pay → Dispute Flow Against Live Services
 *
 * Tests the x402r CLI commands end-to-end against real deployed services:
 *   - Railway merchant server (or local via MERCHANT_URL)
 *   - Facilitator (Ultravioleta or local)
 *   - EigenCloud arbiter (auto-evaluates disputes)
 *
 * Flow:
 *   Phase 1: Setup wallet, check balances
 *   Phase 2: `x402r pay` against merchant (tests the new pay command)
 *   Phase 3: CLI dispute (verify compositeKey + dashboard link), status, show
 *   Phase 4: Wait for auto-evaluation (merchant bot + arbiter)
 *
 * Prerequisites:
 *   - Base Sepolia ETH (~0.001 for gas)
 *   - Base Sepolia USDC (0.01 USDC = 10000 units)
 *   - CLI packages available (pnpm install in x402r-arbiter-eigencloud)
 *
 * Usage:
 *   PRIVATE_KEY=0x... pnpm e2e:live
 *   PRIVATE_KEY=0x... MERCHANT_URL=http://localhost:4021/weather pnpm e2e:live
 */

import { execSync } from "child_process";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  formatUnits,
  erc20Abi,
  type Address,
  type Chain,
} from "viem";
import { baseSepolia, base, sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import {
  resolveAddresses,
  type PaymentInfo,
} from "@x402r/core";
import { X402rClient } from "@x402r/client";
import { loadPaymentState } from "./cli/src/state.js";

// ============ Config ============

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_BIN = path.join(__dirname, "cli", "bin", "x402r.ts");

const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}`;
if (!PRIVATE_KEY) {
  console.error("Error: PRIVATE_KEY environment variable is required");
  console.error("Usage: PRIVATE_KEY=0x... pnpm e2e:live");
  process.exit(1);
}

const NETWORK_ID = process.env.NETWORK_ID ?? "eip155:84532";
const CHAIN_ID = parseInt(NETWORK_ID.split(":")[1], 10);

const CHAINS: Record<number, Chain> = {
  84532: baseSepolia,
  8453: base,
  11155111: sepolia,
};
const chain = CHAINS[CHAIN_ID];
if (!chain) {
  console.error(`Unsupported chain in NETWORK_ID: ${NETWORK_ID}`);
  process.exit(1);
}

const USDC_ADDRESSES: Record<number, Address> = {
  84532: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  11155111: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
};
const USDC_ADDRESS = USDC_ADDRESSES[CHAIN_ID]!;

const SCANNERS: Record<number, string> = {
  84532: "https://sepolia.basescan.org",
  8453: "https://basescan.org",
  11155111: "https://sepolia.etherscan.io",
};
const SCANNER = SCANNERS[CHAIN_ID]!;

const MERCHANT_URL =
  process.env.MERCHANT_URL ??
  "https://fantastic-optimism-production-602a.up.railway.app/weather";
const OPERATOR_ADDRESS = (process.env.OPERATOR_ADDRESS ??
  "0xF5C1712736D3B8f34F245430edF9dF0aAd00D5B0") as Address;
const ARBITER_URL =
  process.env.ARBITER_URL ?? "https://www.moltarbiter.fun/arbiter";
const RPC_URL = process.env.RPC_URL;

// How long to wait for merchant bot + arbiter auto-eval (ms)
const AUTO_EVAL_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 10_000;

// ============ Helpers ============

function log(msg: string): void {
  console.log(`  ${msg}`);
}

function step(name: string): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`STEP: ${name}`);
  console.log("=".repeat(60));
}

function pass(name: string): void {
  console.log(`  ✓ PASS: ${name}`);
}

function fail(name: string, error: string): void {
  console.log(`  ✗ FAIL: ${name}`);
  console.log(`    error: ${error}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCli(args: string): string {
  const cmd = `tsx "${CLI_BIN}" ${args}`;
  try {
    return execSync(cmd, {
      cwd: __dirname,
      env: {
        ...process.env,
        NETWORK_ID,
        ARBITER_URL,
        ...(RPC_URL ? { RPC_URL } : {}),
      },
      encoding: "utf-8",
      timeout: 120_000,
    });
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string };
    if (execError.stdout) return execError.stdout;
    throw new Error(
      `CLI failed: ${cmd}\nstdout: ${execError.stdout ?? ""}\nstderr: ${execError.stderr ?? ""}`,
    );
  }
}

// ============ Main ============

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║    x402r E2E Live Test — Pay + Dispute Flow             ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  let passed = 0;
  let failed = 0;

  function trackPass(name: string): void {
    pass(name);
    passed++;
  }

  function trackFail(name: string, error: string): void {
    fail(name, error);
    failed++;
  }

  // ================================================================
  // Phase 1: Setup
  // ================================================================
  step("Phase 1: Setup — Wallet & Balances");

  const account = privateKeyToAccount(PRIVATE_KEY);
  const publicClient = createPublicClient({
    chain,
    transport: http(RPC_URL),
  });
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(RPC_URL),
  });

  log(`Payer address: ${account.address}`);
  log(`Merchant URL:  ${MERCHANT_URL}`);
  log(`Operator:      ${OPERATOR_ADDRESS}`);
  log(`Network:       ${NETWORK_ID}`);
  log(`Arbiter URL:   ${ARBITER_URL}`);

  const ethBalance = await publicClient.getBalance({ address: account.address });
  const usdcBalance = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });

  log(`ETH balance:   ${formatEther(ethBalance)} ETH`);
  log(`USDC balance:  ${formatUnits(usdcBalance, 6)} USDC`);

  if (ethBalance < 100000000000000n) {
    console.error("Error: Need at least 0.0001 ETH for gas");
    process.exit(1);
  }
  if (usdcBalance < 10000n) {
    console.error("Error: Need at least 0.01 USDC for payment");
    process.exit(1);
  }

  trackPass("Wallet setup and balance check");

  // ================================================================
  // Phase 2: Pay via CLI (`x402r pay`)
  // ================================================================
  step("Phase 2: x402r pay — Escrow Payment via CLI");

  // 2a. Configure CLI
  log("Configuring CLI...");
  try {
    const configOutput = runCli(
      `config --key ${PRIVATE_KEY} --operator ${OPERATOR_ADDRESS} --network ${NETWORK_ID} --arbiter-url ${ARBITER_URL}${RPC_URL ? ` --rpc ${RPC_URL}` : ""}`,
    );
    log(configOutput.trim());
    trackPass("CLI config set");
  } catch (error) {
    trackFail(
      "CLI config",
      error instanceof Error ? error.message : String(error),
    );
  }

  // 2b. Run `x402r pay <merchant-url>`
  log(`Running: x402r pay ${MERCHANT_URL}`);
  let payOutput = "";
  try {
    payOutput = runCli(`pay ${MERCHANT_URL}`);
    log(payOutput.trim());

    if (payOutput.includes("Payment Complete")) {
      trackPass("x402r pay completed successfully");
    } else if (payOutput.includes("no payment required")) {
      trackFail("x402r pay", "Server did not return 402 — no payment needed");
      console.error("Cannot continue without a payment.");
      process.exit(1);
    } else {
      trackFail("x402r pay", "Unexpected output (no 'Payment Complete')");
    }
  } catch (error) {
    trackFail(
      "x402r pay",
      error instanceof Error ? error.message : String(error),
    );
    console.error("Cannot continue without a successful payment.");
    process.exit(1);
  }

  // 2c. Verify payment hash in output
  const hashMatch = payOutput.match(/Payment Hash:\s+(0x[a-fA-F0-9]+)/);
  if (hashMatch) {
    log(`Payment Hash: ${hashMatch[1]}`);
    trackPass("Pay output includes payment hash");
  } else {
    trackFail("Pay output", "No payment hash found in output");
  }

  // 2d. Verify settle tx in output (optional — depends on facilitator)
  if (payOutput.includes("Settle Tx:")) {
    const txMatch = payOutput.match(/Settle Tx:\s+(0x[a-fA-F0-9]+)/);
    if (txMatch) {
      log(`Settle Tx: ${txMatch[1]}`);
      log(`${SCANNER}/tx/${txMatch[1]}`);
    }
    trackPass("Pay output includes settle tx hash");
  } else {
    log("(No settle tx in output — facilitator may not return it)");
  }

  // 2e. Verify payment state was saved
  const paymentState = loadPaymentState();
  if (!paymentState) {
    trackFail("Payment state", "No payment state found at ~/.x402r/last-payment.json");
    console.error("Cannot continue without saved payment state.");
    process.exit(1);
  }

  const paymentInfo: PaymentInfo = paymentState.paymentInfo;
  log(`Saved PaymentInfo:`);
  log(`  operator: ${paymentInfo.operator}`);
  log(`  payer:    ${paymentInfo.payer}`);
  log(`  receiver: ${paymentInfo.receiver}`);
  log(`  amount:   ${formatUnits(paymentInfo.maxAmount, 6)} USDC`);
  trackPass("Payment state saved to ~/.x402r/last-payment.json");

  // 2f. Verify USDC was deducted
  const usdcAfterPay = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  const spent = usdcBalance - usdcAfterPay;
  log(`USDC spent: ${formatUnits(spent, 6)} USDC`);
  if (spent > 0n) {
    trackPass("USDC deducted from payer balance");
  } else {
    log("(USDC not yet deducted — may still be in escrow pending settlement)");
  }

  // ================================================================
  // Phase 3: CLI Dispute (tests compositeKey + dashboard link)
  // ================================================================
  step("Phase 3: x402r dispute — File Dispute via CLI");

  // 3a. File dispute
  log("Filing dispute...");
  let disputeOutput = "";
  try {
    disputeOutput = runCli(
      'dispute "E2E live test: weather data was incorrect" --evidence "Expected sunny forecast, received rainy. Request made at UTC noon."',
    );
    log(disputeOutput.trim());

    if (
      disputeOutput.includes("Dispute Created") ||
      disputeOutput.includes("Evidence submitted") ||
      disputeOutput.includes("Refund request submitted")
    ) {
      trackPass("CLI dispute filed successfully");
    } else {
      trackFail("CLI dispute", "Unexpected output (no success indicator)");
    }
  } catch (error) {
    trackFail(
      "CLI dispute",
      error instanceof Error ? error.message : String(error),
    );
  }

  // 3b. Verify compositeKey in output
  const compositeKeyMatch = disputeOutput.match(/Composite Key:\s+(0x[a-fA-F0-9]+)/);
  if (compositeKeyMatch) {
    log(`Composite Key: ${compositeKeyMatch[1]}`);
    trackPass("Dispute output includes composite key");
  } else {
    trackFail("Dispute output", "No composite key found in output");
  }

  // 3c. Verify dashboard link in output
  const dashboardMatch = disputeOutput.match(/Dashboard:\s+(https?:\/\/\S+)/);
  if (dashboardMatch) {
    log(`Dashboard link: ${dashboardMatch[1]}`);
    trackPass("Dispute output includes dashboard link");
  } else {
    trackFail("Dispute output", "No dashboard link found in output");
  }

  // 3d. Check status (should be Pending)
  log("Checking dispute status...");
  try {
    const statusOutput = runCli("status");
    log(statusOutput.trim());

    if (statusOutput.includes("Pending") || statusOutput.includes("pending")) {
      trackPass("CLI status shows Pending");
    } else {
      trackFail(
        "CLI status (Pending)",
        `Expected 'Pending' in output`,
      );
    }
  } catch (error) {
    trackFail(
      "CLI status",
      error instanceof Error ? error.message : String(error),
    );
  }

  // 3e. Show evidence
  log("Showing dispute evidence...");
  // Brief delay for RPC state propagation
  await sleep(3000);
  try {
    const showOutput = runCli("show");
    log(showOutput.trim());

    if (showOutput.includes("Evidence") || showOutput.includes("Payer")) {
      trackPass("CLI show displays payer evidence");
    } else {
      trackFail("CLI show", "Expected evidence in output");
    }
  } catch (error) {
    trackFail(
      "CLI show",
      error instanceof Error ? error.message : String(error),
    );
  }

  // ================================================================
  // Phase 4: Wait for Auto-Evaluation
  // ================================================================
  step("Phase 4: Wait for Auto-Evaluation");

  log(
    `Waiting up to ${AUTO_EVAL_TIMEOUT_MS / 1000}s for merchant bot evidence + arbiter auto-eval...`,
  );
  log(
    "  (Merchant bot watches RefundRequested events and auto-submits counter-evidence)",
  );
  log(
    "  (Arbiter watches EvidenceSubmitted events and auto-evaluates when both parties submit)",
  );

  // Create SDK client for polling
  const addresses = resolveAddresses(NETWORK_ID);
  const client = new X402rClient({
    publicClient: publicClient as any,
    walletClient: walletClient as any,
    operatorAddress: OPERATOR_ADDRESS,
    escrowAddress: addresses.escrowAddress,
    refundRequestAddress: addresses.refundRequestAddress,
    refundRequestEvidenceAddress: addresses.evidenceAddress,
    chainId: CHAIN_ID,
  });

  const startWait = Date.now();
  let merchantEvidenceFound = false;
  let arbiterEvidenceFound = false;
  let finalStatus: string | undefined;

  while (Date.now() - startWait < AUTO_EVAL_TIMEOUT_MS) {
    const elapsed = Math.round((Date.now() - startWait) / 1000);

    try {
      const allEvidence = await client.getAllEvidence(paymentInfo, 0n);
      const payerEvidence = allEvidence.filter((e) => e.role === 0);
      const merchantEvidence = allEvidence.filter((e) => e.role === 1);
      const arbiterEvidence = allEvidence.filter((e) => e.role === 2);

      if (merchantEvidence.length > 0 && !merchantEvidenceFound) {
        merchantEvidenceFound = true;
        log(`[${elapsed}s] Merchant evidence detected (${merchantEvidence.length} entry)`);
        trackPass("Merchant bot submitted counter-evidence");
      }

      if (arbiterEvidence.length > 0 && !arbiterEvidenceFound) {
        arbiterEvidenceFound = true;
        log(`[${elapsed}s] Arbiter evidence detected (${arbiterEvidence.length} entry)`);
        trackPass("Arbiter submitted ruling evidence");
      }

      // Check refund status
      const status = await client.getRefundStatus(paymentInfo, 0n);
      const statusName =
        status === 0
          ? "Pending"
          : status === 1
            ? "Approved"
            : status === 2
              ? "Denied"
              : status === 3
                ? "Cancelled"
                : `Unknown(${status})`;

      if (status !== 0) {
        finalStatus = statusName;
        log(`[${elapsed}s] Dispute resolved: ${statusName}`);
        break;
      }

      log(
        `[${elapsed}s] Polling... evidence: payer=${payerEvidence.length}, merchant=${merchantEvidence.length}, arbiter=${arbiterEvidence.length}, status=${statusName}`,
      );
    } catch (err) {
      log(`[${elapsed}s] Poll error: ${err}`);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  if (!merchantEvidenceFound) {
    trackFail(
      "Merchant bot evidence",
      "Timed out waiting for merchant evidence",
    );
  }

  if (!arbiterEvidenceFound) {
    trackFail(
      "Arbiter ruling evidence",
      "Timed out waiting for arbiter evaluation",
    );
  }

  if (finalStatus) {
    trackPass(`Dispute resolved with status: ${finalStatus}`);
  } else {
    trackFail("Dispute resolution", "Timed out — dispute still Pending");
  }

  // 4b. CLI show after evaluation
  log("Checking final CLI show...");
  try {
    const showOutput = runCli("show");
    log(showOutput.trim());
    trackPass("CLI show displays full evidence after evaluation");
  } catch (error) {
    trackFail(
      "CLI show (final)",
      error instanceof Error ? error.message : String(error),
    );
  }

  // 4c. CLI status after evaluation
  log("Checking final CLI status...");
  try {
    const statusOutput = runCli("status");
    log(statusOutput.trim());

    if (
      statusOutput.includes("Approved") ||
      statusOutput.includes("Denied")
    ) {
      trackPass("CLI status shows final ruling");
    } else {
      trackFail(
        "CLI status (final)",
        "Expected 'Approved' or 'Denied' in output",
      );
    }
  } catch (error) {
    trackFail(
      "CLI status (final)",
      error instanceof Error ? error.message : String(error),
    );
  }

  // 4d. Verify dashboard link works (fetch dispute page)
  if (compositeKeyMatch) {
    log("Verifying dashboard link...");
    try {
      const dashboardBase = ARBITER_URL.replace(/\/arbiter\/?$/, "");
      const disputeApiUrl = `${ARBITER_URL}/api/dispute/${compositeKeyMatch[1]}`;
      const apiResponse = await fetch(disputeApiUrl);
      if (apiResponse.ok) {
        const disputeData = await apiResponse.json() as Record<string, unknown>;
        log(`Dashboard API: status=${disputeData.status}, amount=${disputeData.amount}`);
        trackPass("Dashboard API returns dispute data");
      } else {
        trackFail("Dashboard API", `GET ${disputeApiUrl} returned ${apiResponse.status}`);
      }
    } catch (error) {
      trackFail(
        "Dashboard API",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // ================================================================
  // Summary
  // ================================================================
  console.log(
    "\n╔══════════════════════════════════════════════════════════╗",
  );
  console.log(
    "║                    TEST SUMMARY                        ║",
  );
  console.log(
    "╚══════════════════════════════════════════════════════════╝",
  );

  console.log(`\n  Result: ${passed} passed, ${failed} failed out of ${passed + failed} steps`);

  if (failed > 0) {
    console.log("\n  ✗ E2E LIVE TEST FAILED");
    process.exit(1);
  } else {
    console.log("\n  ✓ E2E LIVE TEST PASSED — Full pay + dispute lifecycle verified");
  }
}

main().catch((error) => {
  console.error("\nE2E live test failed with error:", error);
  process.exit(1);
});
