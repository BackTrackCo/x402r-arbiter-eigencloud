/**
 * verify command — Replay arbiter evaluation and verify commitment hashes
 */

import type { Command } from "commander";
import { initReadOnly } from "../setup.js";
import { getPaymentInfo, getNonce } from "../state.js";
import { getConfig } from "../config.js";

export function registerVerifyCommand(program: Command): void {
  program
    .command("verify")
    .description("Verify arbiter ruling by replaying AI evaluation")
    .option("-p, --payment-json <json>", "Payment info JSON (uses saved state if omitted)")
    .option("-n, --nonce <nonce>", "Nonce")
    .action(async (options) => {
      const config = getConfig();
      const { arbiterUrl } = await initReadOnly();
      const paymentInfo = getPaymentInfo(options);
      const nonce = getNonce(options);

      const url = config.arbiterUrl || arbiterUrl;
      console.log(`\nVerifying dispute via ${url}...`);

      try {
        const response = await fetch(`${url}/api/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            paymentInfo: JSON.parse(
              JSON.stringify(paymentInfo, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
            ),
            nonce: nonce.toString(),
          }),
        });

        if (!response.ok) {
          const error = await response.text();
          console.error(`\nArbiter returned ${response.status}:`, error);
          process.exit(1);
        }

        const data = await response.json() as {
          replayCommitment: {
            commitmentHash: string;
            promptHash: string;
            responseHash: string;
            seed: number;
          };
          displayContent: string;
          note: string;
        };

        console.log("\n=== Verification Result ===");
        console.log("\n  Commitment Hash:", data.replayCommitment.commitmentHash);
        console.log("  Prompt Hash:", data.replayCommitment.promptHash);
        console.log("  Response Hash:", data.replayCommitment.responseHash);
        console.log("  Seed:", data.replayCommitment.seed);

        // Try to parse the AI response
        try {
          const decision = JSON.parse(data.displayContent);
          console.log("\n=== AI Decision (Replay) ===");
          console.log("  Decision:", decision.decision);
          console.log("  Confidence:", decision.confidence);
          console.log("  Reasoning:", decision.reasoning);
        } catch {
          console.log("\n  Raw Response:", data.displayContent);
        }

        console.log("\n  Note:", data.note);
      } catch (error) {
        console.error("\nFailed to verify:", error instanceof Error ? error.message : error);
        console.error("Is the arbiter server running at", url, "?");
        process.exit(1);
      }
    });
}
