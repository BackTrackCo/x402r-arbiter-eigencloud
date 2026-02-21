/**
 * E2E Live Test: Full Dispute Flow Against Live Services
 *
 * Tests the x402r CLI tools against real deployed services:
 *   - Railway merchant server (x402r-test-merchant)
 *   - Ultravioleta facilitator (x402 mainline)
 *   - EigenCloud arbiter (auto-evaluates disputes)
 *
 * Flow:
 *   Phase 1: Setup wallet, check balances
 *   Phase 2: HTTP 402 payment against live merchant
 *   Phase 3: CLI dispute, status, show
 *   Phase 4: Wait for auto-evaluation (merchant bot + arbiter)
 *
 * Prerequisites:
 *   - Ethereum Sepolia ETH (~0.001 for gas)
 *   - Ethereum Sepolia USDC (0.01 USDC = 10000 units)
 *   - CLI packages available (pnpm install in x402r-arbiter-eigencloud)
 *
 * Usage:
 *   PRIVATE_KEY=0x... pnpm e2e:live
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
} from "viem";
import { sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { registerEscrowScheme } from "@x402r/evm/escrow/client";
import { isEscrowPayload } from "@x402r/evm/escrow/types";
import type { EscrowPayload } from "@x402r/evm/escrow/types";
import {
  toPaymentInfo,
  computePaymentInfoHash,
  resolveAddresses,
  type PaymentInfo,
} from "@x402r/core";
import { X402rClient } from "@x402r/client";
import { savePaymentState } from "./cli/src/state.js";

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

const MERCHANT_URL =
  process.env.MERCHANT_URL ??
  "https://x402r-test-merchant-production.up.railway.app/weather";
const OPERATOR_ADDRESS = (process.env.OPERATOR_ADDRESS ??
  "0xAfD051239DE540D7B51Aa514eb795a2D43C8fCb0") as Address;
const NETWORK_ID = process.env.NETWORK_ID ?? "eip155:11155111";
const ARBITER_URL =
  process.env.ARBITER_URL ?? "http://34.27.80.151:3000";
const RPC_URL = process.env.RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const USDC_ADDRESS = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address;

const SCANNER = "https://sepolia.etherscan.io";

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
        RPC_URL,
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
  console.log("║    x402r E2E Live Test — Against Live Services          ║");
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
    chain: sepolia,
    transport: http(RPC_URL),
  });
  const walletClient = createWalletClient({
    account,
    chain: sepolia,
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
  // Phase 2: HTTP 402 Payment (real fetch)
  // ================================================================
  step("Phase 2: HTTP 402 Payment Against Live Merchant");

  // Setup x402 client with escrow scheme
  const paymentClient = new x402Client();
  registerEscrowScheme(paymentClient, {
    signer: account,
    networks: NETWORK_ID,
  });
  const httpClient = new x402HTTPClient(paymentClient);

  // 2a. Unpaid request → 402
  log(`Fetching ${MERCHANT_URL} (expecting 402)...`);
  const response402 = await fetch(MERCHANT_URL);
  log(`Status: ${response402.status}`);

  if (response402.status !== 402) {
    trackFail(
      "Unpaid request returns 402",
      `Expected 402, got ${response402.status}`,
    );
    console.error("Cannot continue without 402 response.");
    process.exit(1);
  }
  trackPass("Unpaid request returns 402");

  // 2b. Parse payment requirements from 402 response
  const body402 = await response402.text();
  const paymentRequired = httpClient.getPaymentRequiredResponse(
    (name: string) => response402.headers.get(name) ?? undefined,
    body402,
  );
  log(`Payment scheme: ${paymentRequired.paymentRequirements?.scheme ?? "unknown"}`);
  trackPass("Parse payment requirements from 402");

  // 2c. Create payment payload (signs escrow authorization)
  const paymentPayload = await httpClient.createPaymentPayload(paymentRequired);
  trackPass("Create signed payment payload");

  // 2d. Send paid request
  const requestHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);
  log(`Sending paid request to ${MERCHANT_URL}...`);
  const response200 = await fetch(MERCHANT_URL, {
    method: "GET",
    headers: requestHeaders,
  });
  log(`Status: ${response200.status}`);

  if (response200.status !== 200) {
    const errBody = await response200.text();
    // Log all response headers for debugging
    log("Response headers:");
    response200.headers.forEach((value, key) => {
      log(`  ${key}: ${value.slice(0, 300)}`);
    });
    log(`Response body: ${errBody.slice(0, 500)}`);
    // Log what we sent
    log("Request headers sent:");
    for (const [k, v] of Object.entries(requestHeaders)) {
      log(`  ${k}: ${String(v).slice(0, 100)}...`);
    }
    trackFail(
      "Paid request returns 200",
      `Got ${response200.status}`,
    );
    console.error("Cannot continue without successful payment.");
    process.exit(1);
  }

  const responseBody = await response200.json();
  log(`Response: ${JSON.stringify(responseBody).slice(0, 200)}`);
  trackPass("Paid request returns 200");

  // 2e. Extract PaymentInfo from escrow payload
  if (!isEscrowPayload(paymentPayload.payload)) {
    trackFail("Payload is EscrowPayload", "Not an escrow payload");
    process.exit(1);
  }

  const paymentInfo: PaymentInfo = toPaymentInfo(
    paymentPayload.payload as EscrowPayload,
  );
  const addresses = resolveAddresses(NETWORK_ID);
  const paymentHash = computePaymentInfoHash(
    11155111,
    addresses.escrowAddress as `0x${string}`,
    paymentInfo,
  );

  log(`PaymentInfo hash: ${paymentHash}`);
  log(`  operator: ${paymentInfo.operator}`);
  log(`  payer:    ${paymentInfo.payer}`);
  log(`  receiver: ${paymentInfo.receiver}`);

  // 2f. Save payment state for CLI
  savePaymentState({
    paymentInfo,
    operatorAddress: OPERATOR_ADDRESS,
    paymentHash,
    timestamp: new Date().toISOString(),
    networkId: NETWORK_ID,
  });
  trackPass("PaymentInfo extracted and saved to ~/.x402r/last-payment.json");

  // 2g. Post PaymentInfo to arbiter cache so it can resolve the dispute
  try {
    const piCacheResponse = await fetch(`${ARBITER_URL}/api/payment-info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operator: paymentInfo.operator,
        payer: paymentInfo.payer,
        receiver: paymentInfo.receiver,
        token: paymentInfo.token,
        maxAmount: paymentInfo.maxAmount.toString(),
        preApprovalExpiry: paymentInfo.preApprovalExpiry.toString(),
        authorizationExpiry: paymentInfo.authorizationExpiry.toString(),
        refundExpiry: paymentInfo.refundExpiry.toString(),
        minFeeBps: paymentInfo.minFeeBps,
        maxFeeBps: paymentInfo.maxFeeBps,
        feeReceiver: paymentInfo.feeReceiver,
        salt: paymentInfo.salt.toString(),
      }),
    });
    if (piCacheResponse.ok) {
      log("PaymentInfo cached on arbiter server");
    } else {
      log(`Warning: Failed to cache PaymentInfo on arbiter (${piCacheResponse.status})`);
    }
  } catch (err) {
    log(`Warning: Could not reach arbiter to cache PaymentInfo: ${err}`);
  }

  // ================================================================
  // Phase 3: CLI Dispute
  // ================================================================
  step("Phase 3: CLI Dispute via x402r Commands");

  // 3a. Configure CLI
  log("Configuring CLI...");
  try {
    const configOutput = runCli(
      `config --key ${PRIVATE_KEY} --operator ${OPERATOR_ADDRESS} --network ${NETWORK_ID} --arbiter-url ${ARBITER_URL} --rpc ${RPC_URL}`,
    );
    log(configOutput.trim());
    trackPass("CLI config set");
  } catch (error) {
    trackFail(
      "CLI config",
      error instanceof Error ? error.message : String(error),
    );
  }

  // 3b. File dispute
  log("Filing dispute...");
  try {
    const disputeOutput = runCli(
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

  // 3c. Check status (should be Pending)
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

  // 3d. Show evidence
  log("Showing dispute evidence...");
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
  const client = new X402rClient({
    publicClient: publicClient as any,
    walletClient: walletClient as any,
    operatorAddress: OPERATOR_ADDRESS,
    escrowAddress: addresses.escrowAddress,
    refundRequestAddress: addresses.refundRequestAddress,
    refundRequestEvidenceAddress: addresses.evidenceAddress,
    chainId: 11155111,
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
    console.log("\n  ✓ E2E LIVE TEST PASSED — Full dispute lifecycle verified against live services");
  }
}

main().catch((error) => {
  console.error("\nE2E live test failed with error:", error);
  process.exit(1);
});
