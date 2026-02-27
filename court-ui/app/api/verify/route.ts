import { NextRequest, NextResponse } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import { getEvidenceBatch, type EvidenceEntry } from "@/lib/contracts";
import { fetchEvidenceContent } from "@/lib/ipfs";
import { EigenAIClient } from "@/lib/eigenai-client";
import { SYSTEM_PROMPT, buildPrompt } from "@/lib/prompts";
import { createCommitment } from "@/lib/commitment";

const VERIFIER_PRIVATE_KEY = process.env.VERIFIER_PRIVATE_KEY as
  | `0x${string}`
  | undefined;
const EIGENAI_GRANT_SERVER =
  process.env.EIGENAI_GRANT_SERVER ??
  "https://determinal-api.eigenarcade.com";
const EIGENAI_MODEL = process.env.EIGENAI_MODEL ?? "gpt-oss-120b-f16";
const DEFAULT_SEED = 42;

/** Keep only the first (earliest) evidence entry per role. */
function firstEvidencePerRole(entries: EvidenceEntry[]): EvidenceEntry[] {
  const seen = new Set<number>();
  return entries.filter((e) => {
    if (seen.has(e.role)) return false;
    seen.add(e.role);
    return true;
  });
}

export async function POST(req: NextRequest) {
  try {
    if (!VERIFIER_PRIVATE_KEY) {
      return NextResponse.json(
        { error: "VERIFIER_PRIVATE_KEY not configured" },
        { status: 503 },
      );
    }

    const body = await req.json();
    const { paymentInfo, nonce } = body;

    if (!paymentInfo || nonce === undefined) {
      return NextResponse.json(
        { error: "paymentInfo and nonce are required" },
        { status: 400 },
      );
    }

    // 1. Fetch all evidence from chain
    const result = await getEvidenceBatch(paymentInfo, BigInt(nonce));
    const deduped = firstEvidencePerRole(result.entries);
    const arbiterEvidence = deduped.filter((e) => e.role === 2);
    const partyEvidence = deduped.filter((e) => e.role !== 2);

    if (partyEvidence.length === 0) {
      return NextResponse.json(
        { error: "No party evidence found for this dispute" },
        { status: 404 },
      );
    }

    // 2. Extract seed from arbiter's on-chain evidence
    let seed = DEFAULT_SEED;
    let originalCommitment: Record<string, unknown> | null = null;
    for (const entry of arbiterEvidence) {
      try {
        const content = await fetchEvidenceContent(entry.cid);
        const parsed = JSON.parse(content);
        if (parsed.commitment?.seed !== undefined) {
          seed = parsed.commitment.seed;
          originalCommitment = parsed.commitment;
          break;
        }
        if (parsed.seed !== undefined) {
          seed = parsed.seed;
          break;
        }
      } catch {
        // Failed to resolve — skip
      }
    }

    // 3. Resolve party evidence content from IPFS
    const evidenceContent = new Map<string, string>();
    for (const entry of partyEvidence) {
      try {
        const content = await fetchEvidenceContent(entry.cid);
        evidenceContent.set(entry.cid, content);
      } catch {
        evidenceContent.set(entry.cid, "(failed to retrieve)");
      }
    }

    // 4. Build the same deterministic prompt
    const userPrompt = buildPrompt(partyEvidence, evidenceContent);

    // 5. Call EigenAI with court-ui's own wallet + grant
    const account = privateKeyToAccount(VERIFIER_PRIVATE_KEY);
    const eigenai = new EigenAIClient(account, EIGENAI_GRANT_SERVER, EIGENAI_MODEL);
    const aiResult = await eigenai.evaluate(SYSTEM_PROMPT, userPrompt, seed);

    // 6. Compute replay commitment
    const replayCommitment = createCommitment(
      userPrompt,
      seed,
      aiResult.displayContent,
    );

    return NextResponse.json({
      replayCommitment,
      originalCommitment,
      displayContent: aiResult.displayContent,
      note: "Independent verification — called EigenAI directly from court-ui, not through the arbiter",
    });
  } catch (err) {
    console.error("Independent verify error:", err);
    return NextResponse.json(
      { error: String(err) },
      { status: 500 },
    );
  }
}
