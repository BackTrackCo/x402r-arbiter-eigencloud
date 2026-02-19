import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Chain,
  type Hex,
  type Address,
} from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { baseSepolia, base, sepolia } from "viem/chains";
import { X402rArbiter } from "@x402r/arbiter";
import {
  resolveAddresses,
  parsePaymentInfo,
  indexPaymentInfoFromEvents,
  resolveEvidenceContent,
  type PaymentInfo,
} from "@x402r/core";
import { createCommitment } from "./commitment.js";
import { SYSTEM_PROMPT, buildPrompt } from "./prompts.js";
import { EigenAIClient } from "./eigenai-client.js";

dotenv.config();

// --- Environment validation ---
const MNEMONIC = process.env.MNEMONIC;
const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}` | undefined;
const RPC_URL = process.env.RPC_URL;
const CHAIN_ID = parseInt(process.env.CHAIN_ID ?? "84532", 10);
const OPERATOR_ADDRESS = process.env.OPERATOR_ADDRESS as Address | undefined;
const EIGENAI_GRANT_SERVER =
  process.env.EIGENAI_GRANT_SERVER ??
  "https://determinal-api.eigenarcade.com";
const EIGENAI_MODEL = process.env.EIGENAI_MODEL ?? "gpt-oss-120b-f16";
const EIGENAI_SEED = parseInt(process.env.EIGENAI_SEED ?? "42", 10);
const CONFIDENCE_THRESHOLD = parseFloat(
  process.env.CONFIDENCE_THRESHOLD ?? "0.7",
);
const DEFAULT_RECEIVER = process.env.DEFAULT_RECEIVER as Address | undefined;
const PORT = parseInt(process.env.PORT ?? "3000", 10);

if (!MNEMONIC && !PRIVATE_KEY) {
  console.error("MNEMONIC or PRIVATE_KEY environment variable is required");
  process.exit(1);
}
if (!OPERATOR_ADDRESS) {
  console.error("OPERATOR_ADDRESS environment variable is required");
  process.exit(1);
}

// --- Chain config ---
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

// --- Wallet & clients ---
const account = PRIVATE_KEY
  ? privateKeyToAccount(PRIVATE_KEY)
  : mnemonicToAccount(MNEMONIC!);
const transport = http(RPC_URL);

const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ account, chain, transport });

// --- Resolve addresses ---
const addresses = resolveAddresses(networkId);

// --- SDK arbiter ---
const arbiter = new X402rArbiter({
  publicClient: publicClient as any,
  walletClient: walletClient as any,
  operatorAddress: OPERATOR_ADDRESS,
  escrowAddress: addresses.escrowAddress,
  refundRequestAddress: addresses.refundRequestAddress,
  arbiterRegistryAddress: addresses.arbiterRegistryAddress,
  refundRequestEvidenceAddress: addresses.evidenceAddress,
  chainId: CHAIN_ID,
});

// --- EigenAI client ---
const eigenai = new EigenAIClient(account, EIGENAI_GRANT_SERVER, EIGENAI_MODEL);

// --- PaymentInfo cache (hash → serialized PaymentInfo) ---
const paymentInfoCache = new Map<string, Record<string, unknown>>();

/** Index RefundRequested events to auto-populate paymentInfo cache */
async function indexAndCachePaymentInfo() {
  try {
    const indexed = await indexPaymentInfoFromEvents({
      publicClient: publicClient as any,
      escrowAddress: addresses.escrowAddress as `0x${string}`,
      chainId: CHAIN_ID,
      refundRequestAddress: addresses.refundRequestAddress as `0x${string}`,
    });
    for (const [hash, pi] of indexed) {
      const serialized: Record<string, unknown> = {
        operator: pi.operator,
        payer: pi.payer,
        receiver: pi.receiver,
        token: pi.token,
        maxAmount: String(pi.maxAmount),
        preApprovalExpiry: String(pi.preApprovalExpiry),
        authorizationExpiry: String(pi.authorizationExpiry),
        refundExpiry: String(pi.refundExpiry),
        minFeeBps: Number(pi.minFeeBps),
        maxFeeBps: Number(pi.maxFeeBps),
        feeReceiver: pi.feeReceiver,
        salt: String(pi.salt),
      };
      paymentInfoCache.set(hash, serialized);
    }
    console.log(
      `Indexed ${indexed.size} paymentInfos from RefundRequested events`,
    );
  } catch (err) {
    console.warn("Failed to index RefundRequested events:", err);
  }
}

// --- Express app ---
const app = express();
app.use(cors());
app.use(express.json());

// --- Health endpoint ---
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    arbiterAddress: account.address,
    network: networkId,
    chainId: CHAIN_ID,
    model: EIGENAI_MODEL,
    seed: EIGENAI_SEED,
    confidenceThreshold: CONFIDENCE_THRESHOLD,
    operatorAddress: OPERATOR_ADDRESS,
  });
});

// --- Contracts config endpoint (for dashboard) ---
app.get("/api/contracts", (_req, res) => {
  res.json({
    chainId: CHAIN_ID,
    rpcUrl: RPC_URL ?? chain.rpcUrls.default.http[0],
    escrowAddress: addresses.escrowAddress,
    refundRequestAddress: addresses.refundRequestAddress,
    evidenceAddress: addresses.evidenceAddress,
    usdcAddress: addresses.usdc,
  });
});

// --- PaymentInfo cache endpoints ---
app.post("/api/payment-info", (req, res) => {
  try {
    const raw = req.body;
    if (!raw) {
      res.status(400).json({ error: "Request body is required" });
      return;
    }
    const pi = parsePaymentInfo(raw);
    const hash = arbiter.computePaymentInfoHash(pi);
    const serialized = {
      ...raw,
      maxAmount: String(raw.maxAmount ?? pi.maxAmount),
      preApprovalExpiry: String(raw.preApprovalExpiry ?? pi.preApprovalExpiry),
      authorizationExpiry: String(
        raw.authorizationExpiry ?? pi.authorizationExpiry,
      ),
      refundExpiry: String(raw.refundExpiry ?? pi.refundExpiry),
      salt: String(raw.salt ?? pi.salt),
    };
    paymentInfoCache.set(hash, serialized);
    res.json({ hash, stored: true });
  } catch (err) {
    res.status(400).json({ error: String(err) });
  }
});

app.get("/api/payment-info/:hash", (req, res) => {
  const data = paymentInfoCache.get(req.params.hash as Hex);
  if (!data) {
    res.status(404).json({ error: "PaymentInfo not found for this hash" });
    return;
  }
  res.json(data);
});

// --- Evaluate dispute ---
app.post("/api/evaluate", async (req, res) => {
  try {
    const { paymentInfo: paymentInfoRaw, nonce } = req.body;
    if (!paymentInfoRaw || nonce === undefined) {
      res.status(400).json({ error: "paymentInfo and nonce are required" });
      return;
    }

    const paymentInfo: PaymentInfo = parsePaymentInfo(paymentInfoRaw);
    const nonceBI = BigInt(nonce);

    // Cache paymentInfo so the dashboard can look it up later
    const piHash = arbiter.computePaymentInfoHash(paymentInfo);
    if (!paymentInfoCache.has(piHash)) {
      paymentInfoCache.set(piHash, paymentInfoRaw);
    }

    // 1. Get all evidence
    const evidence = await arbiter.getAllEvidence(paymentInfo, nonceBI);
    if (evidence.length === 0) {
      res.status(400).json({ error: "No evidence submitted for this dispute" });
      return;
    }

    // 2. Resolve evidence content (inline JSON or IPFS fetch)
    const evidenceContent = new Map<string, string>();
    for (const entry of evidence) {
      try {
        const content = await resolveEvidenceContent(entry.cid);
        evidenceContent.set(
          entry.cid,
          typeof content === "string" ? content : JSON.stringify(content),
        );
      } catch (err) {
        console.warn(`Failed to resolve evidence ${entry.cid}:`, err);
        evidenceContent.set(entry.cid, "(failed to retrieve)");
      }
    }

    // 3. Build prompt & evaluate via EigenAI (random seed per dispute)
    const seed = Math.floor(Math.random() * 10000);
    const userPrompt = buildPrompt(evidence, evidenceContent);
    const aiResult = await eigenai.evaluate(
      SYSTEM_PROMPT,
      userPrompt,
      seed,
    );

    // 4. Create commitment hash
    const commitment = createCommitment(
      userPrompt,
      seed,
      aiResult.rawResponse,
    );

    // 5. Parse AI decision (model may include reasoning text before the JSON)
    let decision: { decision: string; reasoning: string; confidence: number };
    try {
      decision = JSON.parse(aiResult.displayContent);
    } catch {
      // Try to extract JSON object from the response (model often prepends reasoning)
      const jsonMatch = aiResult.displayContent.match(/\{[\s\S]*"decision"[\s\S]*"reasoning"[\s\S]*"confidence"[\s\S]*\}/);
      if (jsonMatch) {
        try {
          decision = JSON.parse(jsonMatch[0]);
        } catch {
          res.status(500).json({
            error: "Failed to parse AI response",
            rawResponse: aiResult.displayContent,
          });
          return;
        }
      } else {
        res.status(500).json({
          error: "Failed to parse AI response",
          rawResponse: aiResult.displayContent,
        });
        return;
      }
    }

    // 6. Apply confidence threshold to determine on-chain outcome
    const meetsThreshold =
      decision.decision === "approve" &&
      decision.confidence >= CONFIDENCE_THRESHOLD;
    const outcome = meetsThreshold ? "approve" : "deny";

    // 7. Submit arbiter evidence (commitment + decision)
    const evidenceCid = JSON.stringify({
      type: "arbiter-ruling",
      decision: outcome,
      reasoning: decision.reasoning,
      confidence: decision.confidence,
      commitment: {
        commitmentHash: commitment.commitmentHash,
        promptHash: commitment.promptHash,
        responseHash: commitment.responseHash,
        seed: commitment.seed,
      },
      model: EIGENAI_MODEL,
    });
    const submitTx = await arbiter.submitEvidence(
      paymentInfo,
      nonceBI,
      evidenceCid,
    );

    // 8. Submit on-chain decision
    let decisionTx: { txHash: Hex };
    if (meetsThreshold) {
      decisionTx = await arbiter.approveRefundRequest(paymentInfo, nonceBI);

      // 8. Execute refund in escrow if approved
      try {
        const refundTx = await arbiter.executeRefundInEscrow(paymentInfo);
        res.json({
          decision: decision.decision,
          reasoning: decision.reasoning,
          confidence: decision.confidence,
          commitment,
          evidenceSubmitTx: submitTx.txHash,
          decisionTx: decisionTx.txHash,
          refundTx: refundTx.txHash,
        });
        return;
      } catch (refundErr) {
        console.warn("Refund execution failed (may already be settled):", refundErr);
        res.json({
          decision: decision.decision,
          reasoning: decision.reasoning,
          confidence: decision.confidence,
          commitment,
          evidenceSubmitTx: submitTx.txHash,
          decisionTx: decisionTx.txHash,
          refundError: String(refundErr),
        });
        return;
      }
    } else {
      decisionTx = await arbiter.denyRefundRequest(paymentInfo, nonceBI);
    }

    res.json({
      decision: decision.decision,
      reasoning: decision.reasoning,
      confidence: decision.confidence,
      commitment,
      evidenceSubmitTx: submitTx.txHash,
      decisionTx: decisionTx.txHash,
    });
  } catch (err) {
    console.error("Evaluate error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// --- List disputes for a receiver (newest first) ---
app.get("/api/disputes", async (req, res) => {
  try {
    const receiver = (req.query.receiver as Address | undefined) ?? DEFAULT_RECEIVER;
    const offset = BigInt(req.query.offset?.toString() ?? "0");
    const count = BigInt(req.query.count?.toString() ?? "20");

    const result = await arbiter.getReceiverRefundRequests(offset, count, receiver, { order: "newest" });

    res.json({
      keys: result.keys,
      total: result.total.toString(),
      offset: offset.toString(),
      count: count.toString(),
    });
  } catch (err) {
    console.error("List disputes error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// --- Get dispute detail ---
app.get("/api/dispute/:compositeKey", async (req, res) => {
  try {
    const compositeKey = req.params.compositeKey as Hex;
    const data = await arbiter.getRefundRequestByKey(compositeKey);

    res.json({
      paymentInfoHash: data.paymentInfoHash,
      nonce: data.nonce.toString(),
      amount: data.amount.toString(),
      status: data.status,
    });
  } catch (err) {
    console.error("Get dispute error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// --- Verify commitment (replay) ---
app.post("/api/verify", async (req, res) => {
  try {
    const { paymentInfo: paymentInfoRaw, nonce } = req.body;
    if (!paymentInfoRaw || nonce === undefined) {
      res.status(400).json({ error: "paymentInfo and nonce are required" });
      return;
    }

    const paymentInfo: PaymentInfo = parsePaymentInfo(paymentInfoRaw);
    const nonceBI = BigInt(nonce);

    // Separate arbiter evidence (to extract seed) from party evidence (for prompt)
    const allEvidence = await arbiter.getAllEvidence(paymentInfo, nonceBI);
    const arbiterEvidence = allEvidence.filter((e) => e.role === 2);
    const evidence = allEvidence.filter((e) => e.role !== 2);

    // Extract seed from the arbiter's on-chain evidence
    let seed = EIGENAI_SEED; // fallback to global default
    for (const entry of arbiterEvidence) {
      try {
        const parsed = JSON.parse(entry.cid);
        if (parsed.commitment?.seed !== undefined) {
          seed = parsed.commitment.seed;
          break;
        }
        if (parsed.seed !== undefined) {
          seed = parsed.seed;
          break;
        }
      } catch {
        // Not JSON — skip
      }
    }

    const evidenceContent = new Map<string, string>();
    for (const entry of evidence) {
      try {
        const content = await resolveEvidenceContent(entry.cid);
        evidenceContent.set(
          entry.cid,
          typeof content === "string" ? content : JSON.stringify(content),
        );
      } catch {
        evidenceContent.set(entry.cid, "(failed to retrieve)");
      }
    }

    const userPrompt = buildPrompt(evidence, evidenceContent);

    // Replay EigenAI evaluation with the same seed from the original ruling
    const aiResult = await eigenai.evaluate(
      SYSTEM_PROMPT,
      userPrompt,
      seed,
    );

    // Recompute commitment
    const replayCommitment = createCommitment(
      userPrompt,
      seed,
      aiResult.rawResponse,
    );

    res.json({
      replayCommitment,
      displayContent: aiResult.displayContent,
      note: "Compare commitmentHash with the on-chain evidence CID to verify determinism",
    });
  } catch (err) {
    console.error("Verify error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// --- Start server ---
// --- Index existing disputes, then start server ---
indexAndCachePaymentInfo().then(() => {
  app.listen(PORT, () => {
    console.log(`x402r Arbiter (EigenCloud) listening on port ${PORT}`);
    console.log(`  Arbiter address: ${account.address}`);
    console.log(`  Network: ${networkId} (${chain.name})`);
    console.log(`  Operator: ${OPERATOR_ADDRESS}`);
    console.log(`  Model: ${EIGENAI_MODEL}`);
    console.log(`  Confidence threshold: ${CONFIDENCE_THRESHOLD}`);
    console.log(`  PaymentInfos cached: ${paymentInfoCache.size}`);
  });
});
