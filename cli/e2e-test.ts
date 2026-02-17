/**
 * E2E Integration Test: CLI Dispute Flow on Base Sepolia
 *
 * Tests the x402r CLI commands end-to-end against real contracts.
 * Reuses the SDK's shared e2e infrastructure for account setup, operator
 * deployment, and HTTP 402 payment, then runs CLI commands via execSync.
 *
 * Flow:
 *   Setup → HTTP 402 Payment → CLI config → CLI dispute → CLI status →
 *   CLI show → Arbiter approve → CLI status → Execute refund → CLI show
 *
 * Prerequisites:
 *   - Base Sepolia ETH (~0.01 for gas)
 *   - Base Sepolia USDC (0.01 USDC = 10000 units)
 *   - SDK packages built (cd x402r-sdk && pnpm build)
 *
 * Usage:
 *   PRIVATE_KEY=0x... npm run cli:e2e
 */

import { execSync } from "child_process";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  StepRunner,
  PAYMENT_AMOUNT,
  USDC_ADDRESS,
  setupE2EAccounts,
  checkAndLogBalances,
  fundDerivedAccounts,
  deployTestOperator,
  setupHTTP402,
  performHTTP402Payment,
  createSDKInstances,
  shortAddr,
  waitForTx,
  erc20Abi,
  formatUnits,
  type Address,
} from "../../x402r-sdk/examples/e2e-test/shared.js";
import { savePaymentState } from "./src/state.js";

// ============ Config ============

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const CLI_BIN = path.join(__dirname, "bin", "x402r.ts");

// ============ CLI Helper ============

function runCli(args: string): string {
  const cmd = `tsx "${CLI_BIN}" ${args}`;
  try {
    return execSync(cmd, {
      cwd: PROJECT_ROOT,
      env: process.env,
      encoding: "utf-8",
      timeout: 120000,
    });
  } catch (error: unknown) {
    const execError = error as {
      stdout?: string;
      stderr?: string;
    };
    if (execError.stdout) return execError.stdout;
    throw new Error(
      `CLI failed: ${cmd}\nstdout: ${execError.stdout ?? ""}\nstderr: ${execError.stderr ?? ""}`,
    );
  }
}

// ============ Main ============

async function main() {
  console.log(
    "╔══════════════════════════════════════════════════════════╗",
  );
  console.log(
    "║     x402r CLI E2E Test — Base Sepolia                  ║",
  );
  console.log(
    "╚══════════════════════════════════════════════════════════╝",
  );

  const runner = new StepRunner();

  // ---- Step 1: Setup Accounts ----
  runner.step("1. Setup Accounts & Clients");

  const privateKey = process.env.PRIVATE_KEY as `0x${string}`;
  if (!privateKey) {
    console.error("Error: PRIVATE_KEY environment variable is required");
    console.error("Usage: PRIVATE_KEY=0x... npm run cli:e2e");
    process.exit(1);
  }

  const accounts = await setupE2EAccounts(privateKey, { derivedCount: 2 });

  runner.log(`Payer:    ${accounts.payerAccount.address}`);
  runner.log(`Merchant: ${accounts.merchantAccount.address}`);
  runner.log(`Arbiter:  ${accounts.arbiterAccount!.address}`);

  await checkAndLogBalances(accounts, runner);
  await fundDerivedAccounts(accounts, runner);
  runner.pass("Setup accounts and fund derived wallets");

  // ---- Step 2: Deploy Operator ----
  runner.step("2. Deploy Marketplace Operator");

  const deployResult = await deployTestOperator(accounts, runner);
  const operatorAddress = deployResult.operatorAddress as Address;
  runner.log(`Operator: ${operatorAddress}`);

  // ---- Step 3: HTTP 402 Payment ----
  runner.step("3. HTTP 402 Payment (402 → Pay → Verify → Settle)");

  const infra = await setupHTTP402(accounts, operatorAddress);
  runner.pass("Setup HTTP 402 infrastructure");

  const { paymentInfo } = await performHTTP402Payment(
    infra,
    accounts,
    runner,
  );
  runner.log(`PaymentInfo operator: ${shortAddr(paymentInfo.operator)}`);
  runner.log(`PaymentInfo payer: ${shortAddr(paymentInfo.payer)}`);
  runner.log(`PaymentInfo receiver: ${shortAddr(paymentInfo.receiver)}`);

  // Save payment state so CLI picks it up
  savePaymentState({
    paymentInfo,
    operatorAddress,
    paymentHash: "e2e-test",
    timestamp: new Date().toISOString(),
    networkId: "eip155:84532",
  });
  runner.pass("Payment state saved to ~/.x402r/last-payment.json");

  // ---- Step 4: CLI config ----
  runner.step("4. CLI config command");

  try {
    const configOutput = runCli(
      `config --key ${privateKey} --operator ${operatorAddress}`,
    );
    runner.log(configOutput.trim());
    runner.assert(
      configOutput.includes("Config updated") &&
        configOutput.includes(operatorAddress),
      "CLI config sets key and operator",
    );
  } catch (error) {
    runner.fail(
      "CLI config",
      error instanceof Error ? error.message : String(error),
    );
  }

  // ---- Step 5: CLI dispute ----
  runner.step(
    "5. CLI dispute command (requestRefund + submitEvidence)",
  );

  try {
    const disputeOutput = runCli(
      'dispute "E2E test: service returned wrong data" --evidence "Expected sunny, got rainy"',
    );
    runner.log(disputeOutput.trim());
    runner.assert(
      disputeOutput.includes("Dispute Created") ||
        disputeOutput.includes("Evidence submitted"),
      "CLI dispute creates refund request and submits evidence",
    );
  } catch (error) {
    runner.fail(
      "CLI dispute",
      error instanceof Error ? error.message : String(error),
    );
  }

  // ---- Step 6: CLI status ----
  runner.step("6. CLI status command (Pending)");

  try {
    const statusOutput = runCli("status");
    runner.log(statusOutput.trim());
    runner.assert(
      statusOutput.includes("Pending") ||
        statusOutput.includes("Dispute Status"),
      "CLI status shows Pending dispute",
    );
  } catch (error) {
    runner.fail(
      "CLI status",
      error instanceof Error ? error.message : String(error),
    );
  }

  // ---- Step 7: CLI show ----
  runner.step("7. CLI show command (evidence)");

  try {
    const showOutput = runCli("show");
    runner.log(showOutput.trim());
    runner.assert(
      showOutput.includes("Evidence") && showOutput.includes("Payer"),
      "CLI show displays payer evidence",
    );
  } catch (error) {
    runner.fail(
      "CLI show",
      error instanceof Error ? error.message : String(error),
    );
  }

  // ---- Step 8: Arbiter approves (SDK) ----
  runner.step(
    "8. Arbiter approves refund (SDK — no CLI approve command)",
  );

  const { arbiter } = createSDKInstances(accounts, operatorAddress);

  try {
    const { txHash: approveTx } = await arbiter!.approveRefundRequest(
      paymentInfo,
      0n,
    );
    await waitForTx(accounts.publicClient, approveTx);
    runner.pass("Arbiter approves refund", approveTx);
  } catch (error) {
    runner.fail(
      "Arbiter approve",
      error instanceof Error ? error.message : String(error),
    );
  }

  // ---- Step 9: CLI status after approval ----
  runner.step("9. CLI status command (Approved)");

  try {
    const statusOutput = runCli("status");
    runner.log(statusOutput.trim());
    runner.assert(
      statusOutput.includes("Approved"),
      "CLI status shows Approved after arbiter ruling",
    );
  } catch (error) {
    runner.fail(
      "CLI status after approval",
      error instanceof Error ? error.message : String(error),
    );
  }

  // ---- Step 10: Arbiter executes refund ----
  runner.step("10. Arbiter executes refund (SDK)");

  const payerUsdcBefore = await accounts.publicClient.readContract({
    address: USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [accounts.payerAccount.address],
  });

  try {
    const { txHash: executeTx } = await arbiter!.executeRefundInEscrow(
      paymentInfo,
      PAYMENT_AMOUNT,
    );
    await waitForTx(accounts.publicClient, executeTx);
    runner.pass("Execute refund in escrow", executeTx);

    const payerUsdcAfter = await accounts.publicClient.readContract({
      address: USDC_ADDRESS,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [accounts.payerAccount.address],
    });

    const recovered = payerUsdcAfter - payerUsdcBefore;
    runner.log(`Payer recovered: ${formatUnits(recovered, 6)} USDC`);
    runner.assert(
      recovered > 0n,
      "USDC returned to payer",
      `recovered=${recovered}`,
    );
  } catch (error) {
    runner.fail(
      "Execute refund",
      error instanceof Error ? error.message : String(error),
    );
  }

  // ---- Step 11: CLI status final ----
  runner.step("11. CLI status command (final)");

  try {
    const statusOutput = runCli("status");
    runner.log(statusOutput.trim());
    runner.assert(
      statusOutput.includes("Approved"),
      "CLI status still shows Approved after execution",
    );
  } catch (error) {
    runner.fail(
      "CLI status final",
      error instanceof Error ? error.message : String(error),
    );
  }

  // ---- Step 12: CLI show final ----
  runner.step("12. CLI show command (evidence persists)");

  try {
    const showOutput = runCli("show");
    runner.log(showOutput.trim());
    runner.assert(
      showOutput.includes("Evidence") && showOutput.includes("Payer"),
      "CLI show displays evidence after full lifecycle",
    );
  } catch (error) {
    runner.fail(
      "CLI show final",
      error instanceof Error ? error.message : String(error),
    );
  }

  // ---- Summary ----
  console.log(
    "\n╔══════════════════════════════════════════════════════════╗",
  );
  console.log(
    "║                    TEST SUMMARY                        ║",
  );
  console.log(
    "╚══════════════════════════════════════════════════════════╝",
  );

  runner.printSummary("CLI E2E TEST RESULTS");
  runner.exitWithResults(
    "CLI E2E TEST PASSED — Full dispute lifecycle verified",
    "CLI E2E TEST FAILED",
  );
}

main().catch((error) => {
  console.error("\nCLI E2E test failed with error:", error);
  process.exit(1);
});
