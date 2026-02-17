import { type Evidence, SubmitterRole } from "@x402r/core";

const ROLE_LABELS: Record<SubmitterRole, string> = {
  [SubmitterRole.Payer]: "Payer",
  [SubmitterRole.Receiver]: "Receiver",
  [SubmitterRole.Arbiter]: "Arbiter",
};

export const SYSTEM_PROMPT = `You are a neutral payment dispute arbiter. You will be given evidence from a payer and a receiver about a disputed payment. Evaluate the evidence impartially and decide whether the payer deserves a refund.

Rules:
- A refund should be approved if the payer did not receive what was promised, or the service was materially deficient.
- A refund should be denied if the payer received the agreed-upon goods/services and the complaint is unsubstantiated.
- Consider the strength, specificity, and consistency of evidence from both sides.

You MUST respond with ONLY a JSON object in this exact format:
{
  "decision": "approve" | "deny",
  "reasoning": "<2-3 sentence explanation>",
  "confidence": <number between 0 and 1>
}`;

export function buildPrompt(
  evidence: Evidence[],
  evidenceContent: Map<string, string>,
): string {
  const sections: string[] = ["# Dispute Evidence\n"];

  for (const entry of evidence) {
    const role = ROLE_LABELS[entry.role] ?? `Role(${entry.role})`;
    const content = evidenceContent.get(entry.cid) ?? "(content unavailable)";

    sections.push(
      `## ${role} (${entry.submitter})\n` +
        `Submitted: ${new Date(Number(entry.timestamp) * 1000).toISOString()}\n` +
        `CID: ${entry.cid}\n\n` +
        `${content}\n`,
    );
  }

  sections.push(
    "---\n\nBased on the above evidence, provide your decision as JSON.",
  );

  return sections.join("\n");
}
