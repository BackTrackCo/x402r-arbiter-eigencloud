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
import { mnemonicToAccount } from "viem/accounts";
import { baseSepolia, base } from "viem/chains";
import { X402rArbiter } from "@x402r/arbiter";
import {
  resolveAddresses,
  fetchFromIpfs,
  parsePaymentInfo,
  type PaymentInfo,
} from "@x402r/core";
import { createCommitment } from "./commitment.js";
import { SYSTEM_PROMPT, buildPrompt } from "./prompts.js";
import { EigenAIClient } from "./eigenai-client.js";

dotenv.config();

// --- Environment validation ---
const MNEMONIC = process.env.MNEMONIC;
const RPC_URL = process.env.RPC_URL;
const CHAIN_ID = parseInt(process.env.CHAIN_ID ?? "84532", 10);
const OPERATOR_ADDRESS = process.env.OPERATOR_ADDRESS as Address | undefined;
const EIGENAI_GRANT_SERVER =
  process.env.EIGENAI_GRANT_SERVER ??
  "https://determinal-api.eigenarcade.com";
const EIGENAI_MODEL = process.env.EIGENAI_MODEL ?? "gpt-oss-120b-f16";
const EIGENAI_SEED = parseInt(process.env.EIGENAI_SEED ?? "42", 10);
const CONFIDENCE_THRESHOLD = parseFloat(
  process.env.CONFIDENCE_THRESHOLD ?? "0.8",
);
const PORT = parseInt(process.env.PORT ?? "3000", 10);

if (!MNEMONIC) {
  console.error("MNEMONIC environment variable is required");
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
};
const chain = CHAINS[CHAIN_ID];
if (!chain) {
  console.error(`Unsupported CHAIN_ID: ${CHAIN_ID}`);
  process.exit(1);
}

const networkId = `eip155:${CHAIN_ID}`;

// --- Wallet & clients ---
const account = mnemonicToAccount(MNEMONIC);
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

    // 1. Get all evidence
    const evidence = await arbiter.getAllEvidence(paymentInfo, nonceBI);
    if (evidence.length === 0) {
      res.status(400).json({ error: "No evidence submitted for this dispute" });
      return;
    }

    // 2. Fetch IPFS content for each evidence entry
    const evidenceContent = new Map<string, string>();
    for (const entry of evidence) {
      try {
        const content = await fetchFromIpfs<unknown>(entry.cid);
        evidenceContent.set(
          entry.cid,
          typeof content === "string" ? content : JSON.stringify(content),
        );
      } catch (err) {
        console.warn(`Failed to fetch IPFS content for ${entry.cid}:`, err);
        evidenceContent.set(entry.cid, "(failed to retrieve)");
      }
    }

    // 3. Build prompt & evaluate via EigenAI
    const userPrompt = buildPrompt(evidence, evidenceContent);
    const aiResult = await eigenai.evaluate(
      SYSTEM_PROMPT,
      userPrompt,
      EIGENAI_SEED,
    );

    // 4. Create commitment hash
    const commitment = createCommitment(
      userPrompt,
      EIGENAI_SEED,
      aiResult.rawResponse,
    );

    // 5. Submit commitment as arbiter evidence
    const evidenceCid = JSON.stringify({
      type: "arbiter-commitment",
      commitmentHash: commitment.commitmentHash,
      promptHash: commitment.promptHash,
      responseHash: commitment.responseHash,
      seed: commitment.seed,
      model: EIGENAI_MODEL,
    });
    const submitTx = await arbiter.submitEvidence(
      paymentInfo,
      nonceBI,
      evidenceCid,
    );

    // 6. Parse AI decision
    let decision: { decision: string; reasoning: string; confidence: number };
    try {
      decision = JSON.parse(aiResult.displayContent);
    } catch {
      res.status(500).json({
        error: "Failed to parse AI response",
        rawResponse: aiResult.displayContent,
      });
      return;
    }

    // 7. Submit on-chain decision
    let decisionTx: { txHash: Hex };
    if (
      decision.decision === "approve" &&
      decision.confidence >= CONFIDENCE_THRESHOLD
    ) {
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

// --- List disputes for a receiver ---
app.get("/api/disputes", async (req, res) => {
  try {
    const receiver = req.query.receiver as Address | undefined;
    const offset = BigInt(req.query.offset?.toString() ?? "0");
    const count = BigInt(req.query.count?.toString() ?? "20");

    const result = await arbiter.getPendingRefundRequests(
      offset,
      count,
      receiver,
    );

    res.json({
      keys: result.keys.map((k) => k),
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

    // Fetch evidence and rebuild prompt
    const evidence = await arbiter.getAllEvidence(paymentInfo, nonceBI);
    const evidenceContent = new Map<string, string>();
    for (const entry of evidence) {
      try {
        const content = await fetchFromIpfs<unknown>(entry.cid);
        evidenceContent.set(
          entry.cid,
          typeof content === "string" ? content : JSON.stringify(content),
        );
      } catch {
        evidenceContent.set(entry.cid, "(failed to retrieve)");
      }
    }

    const userPrompt = buildPrompt(evidence, evidenceContent);

    // Replay EigenAI evaluation with same seed
    const aiResult = await eigenai.evaluate(
      SYSTEM_PROMPT,
      userPrompt,
      EIGENAI_SEED,
    );

    // Recompute commitment
    const replayCommitment = createCommitment(
      userPrompt,
      EIGENAI_SEED,
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
app.listen(PORT, () => {
  console.log(`x402r Arbiter (EigenCloud) listening on port ${PORT}`);
  console.log(`  Arbiter address: ${account.address}`);
  console.log(`  Network: ${networkId} (${chain.name})`);
  console.log(`  Operator: ${OPERATOR_ADDRESS}`);
  console.log(`  Model: ${EIGENAI_MODEL} (seed=${EIGENAI_SEED})`);
});
