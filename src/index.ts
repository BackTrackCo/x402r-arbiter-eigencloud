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
import {
  mnemonicToAccount,
  privateKeyToAccount,
  generateMnemonic,
} from "viem/accounts";
import { english } from "viem/accounts";
import { baseSepolia, base, sepolia } from "viem/chains";
import { X402rArbiter } from "@x402r/arbiter";
import {
  keccak256,
  encodePacked,
} from "viem";
import {
  resolveAddresses,
  parsePaymentInfo,
  resolveEvidenceContent,
  deployMarketplaceOperator,
  computePaymentInfoHash,
  RefundRequestABI,
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
let OPERATOR_ADDRESS = process.env.OPERATOR_ADDRESS as Address | undefined;
const EIGENAI_GRANT_SERVER =
  process.env.EIGENAI_GRANT_SERVER ??
  "https://determinal-api.eigenarcade.com";
const EIGENAI_MODEL = process.env.EIGENAI_MODEL ?? "gpt-oss-120b-f16";
const EIGENAI_SEED = parseInt(process.env.EIGENAI_SEED ?? "42", 10);
const CONFIDENCE_THRESHOLD = parseFloat(
  process.env.CONFIDENCE_THRESHOLD ?? "0.7",
);
const ESCROW_PERIOD_SECONDS = BigInt(
  process.env.ESCROW_PERIOD_SECONDS ?? "604800",
); // 7 days default
const OPERATOR_FEE_BPS = BigInt(process.env.OPERATOR_FEE_BPS ?? "100"); // 1% default
const PORT = parseInt(process.env.PORT ?? "3000", 10);

// Auto-generate mnemonic if no key is provided (fallback for fresh setups)
const generatedMnemonic =
  !MNEMONIC && !PRIVATE_KEY ? generateMnemonic(english) : undefined;
if (generatedMnemonic) {
  console.warn("No MNEMONIC or PRIVATE_KEY provided — generated ephemeral wallet");
  console.warn("Pass PRIVATE_KEY in env for persistent identity across deployments");
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
const effectiveMnemonic = MNEMONIC ?? generatedMnemonic;
const account = PRIVATE_KEY
  ? privateKeyToAccount(PRIVATE_KEY)
  : mnemonicToAccount(effectiveMnemonic!);
const transport = http(RPC_URL);

const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ account, chain, transport });

// --- Resolve addresses ---
const addresses = resolveAddresses(networkId);

// --- SDK arbiter (initialized after operator is resolved) ---
let arbiter: X402rArbiter;

function initArbiter(operatorAddr: Address) {
  arbiter = new X402rArbiter({
    publicClient: publicClient as any,
    walletClient: walletClient as any,
    operatorAddress: operatorAddr,
    escrowAddress: addresses.escrowAddress,
    refundRequestAddress: addresses.refundRequestAddress,
    arbiterRegistryAddress: addresses.arbiterRegistryAddress,
    refundRequestEvidenceAddress: addresses.evidenceAddress,
    chainId: CHAIN_ID,
  });
}

/** Deploy operator with this arbiter as the registered arbiter */
async function autoDeployOperator(): Promise<Address> {
  console.log("No OPERATOR_ADDRESS set — deploying operator...");
  console.log(`  Arbiter (self): ${account.address}`);
  console.log(`  Fee recipient: ${account.address}`);
  console.log(`  Escrow period: ${ESCROW_PERIOD_SECONDS}s`);
  console.log(`  Operator fee: ${OPERATOR_FEE_BPS} bps`);

  const result = await deployMarketplaceOperator(
    walletClient as any,
    publicClient as any,
    networkId,
    {
      feeRecipient: account.address,
      arbiter: account.address,
      escrowPeriodSeconds: ESCROW_PERIOD_SECONDS,
      operatorFeeBps: OPERATOR_FEE_BPS,
    },
  );

  console.log(`  Operator deployed: ${result.operatorAddress}`);
  console.log(`  New deployments: ${result.summary.newDeployments}, existing: ${result.summary.existingContracts}`);
  return result.operatorAddress;
}

// --- EigenAI client ---
const eigenai = new EigenAIClient(account, EIGENAI_GRANT_SERVER, EIGENAI_MODEL);

// --- PaymentInfo cache (hash → serialized PaymentInfo) ---
const paymentInfoCache = new Map<string, Record<string, unknown>>();

// --- Auto-evaluation tracking ---
const evaluatedDisputes = new Set<string>();

// --- Global ordered dispute keys (newest first, from on-chain events) ---
let orderedDisputeKeys: Hex[] = [];
const MAX_BLOCK_RANGE = 50000n;

// --- Indexed disputes for auto-evaluation (piHash-nonce → PaymentInfo+nonce) ---
const indexedDisputes = new Map<string, { paymentInfo: PaymentInfo; nonce: bigint }>();

/** Index RefundRequested events to populate paymentInfo cache + ordered dispute keys */
async function indexAndCachePaymentInfo() {
  try {
    const prevSize = paymentInfoCache.size;
    const toBlock = await publicClient.getBlockNumber();
    const fromBlock = toBlock > MAX_BLOCK_RANGE ? toBlock - MAX_BLOCK_RANGE : 0n;

    const logs = await publicClient.getContractEvents({
      address: addresses.refundRequestAddress as `0x${string}`,
      abi: RefundRequestABI,
      eventName: "RefundRequested",
      fromBlock,
      toBlock,
    });

    const keys: Hex[] = [];
    for (const log of logs) {
      const args = log.args as any;
      if (!args.paymentInfo) continue;

      const pi = args.paymentInfo;

      // Only index disputes for this arbiter's operator
      if (OPERATOR_ADDRESS && pi.operator.toLowerCase() !== OPERATOR_ADDRESS.toLowerCase()) continue;
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

      // Compute paymentInfoHash and composite key
      const paymentInfo: PaymentInfo = {
        operator: pi.operator,
        payer: pi.payer,
        receiver: pi.receiver,
        token: pi.token,
        maxAmount: pi.maxAmount,
        preApprovalExpiry: pi.preApprovalExpiry,
        authorizationExpiry: pi.authorizationExpiry,
        refundExpiry: pi.refundExpiry,
        minFeeBps: pi.minFeeBps,
        maxFeeBps: pi.maxFeeBps,
        feeReceiver: pi.feeReceiver,
        salt: pi.salt,
      };
      const hash = computePaymentInfoHash(CHAIN_ID, addresses.escrowAddress as `0x${string}`, paymentInfo);
      const nonce = args.nonce as bigint;
      const compositeKey = keccak256(
        encodePacked(["bytes32", "uint256"], [hash, nonce]),
      );

      paymentInfoCache.set(hash, serialized);
      keys.push(compositeKey);

      // Store for auto-evaluation polling
      const disputeKey = `${hash}-${nonce}`;
      if (!indexedDisputes.has(disputeKey)) {
        indexedDisputes.set(disputeKey, { paymentInfo, nonce });
      }
    }

    // Events are in block order (oldest first) — reverse for newest first
    orderedDisputeKeys = keys.reverse();

    if (paymentInfoCache.size > prevSize) {
      console.log(
        `Indexed ${paymentInfoCache.size} paymentInfos (+${paymentInfoCache.size - prevSize} new)`,
      );
    }
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
    status: OPERATOR_ADDRESS ? "ok" : "waiting_for_operator",
    arbiterAddress: account.address,
    network: networkId,
    chainId: CHAIN_ID,
    model: EIGENAI_MODEL,
    seed: EIGENAI_SEED,
    confidenceThreshold: CONFIDENCE_THRESHOLD,
    operatorAddress: OPERATOR_ADDRESS ?? null,
  });
});

// --- Contracts config endpoint (for dashboard, clients, merchants) ---
app.get("/api/contracts", (_req, res) => {
  res.json({
    chainId: CHAIN_ID,
    rpcUrl: RPC_URL ?? chain.rpcUrls.default.http[0],
    operatorAddress: OPERATOR_ADDRESS ?? null,
    arbiterAddress: account.address,
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

// --- Evaluate dispute (reusable core logic) ---

interface EvaluateResult {
  decision: string;
  reasoning: string;
  confidence: number;
  commitment: ReturnType<typeof createCommitment>;
  evidenceSubmitTx: Hex;
  decisionTx: Hex;
  refundTx?: Hex;
  refundError?: string;
}

async function evaluateDispute(
  paymentInfo: PaymentInfo,
  nonce: bigint,
): Promise<EvaluateResult> {
  // 1. Get all evidence
  const evidence = await arbiter.getAllEvidence(paymentInfo, nonce);
  if (evidence.length === 0) {
    throw new Error("No evidence submitted for this dispute");
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

  // 4. Create commitment hash (use displayContent — rawResponse contains
  //    non-deterministic EigenAI channel/message tags that break replay)
  const commitment = createCommitment(
    userPrompt,
    seed,
    aiResult.displayContent,
  );

  // 5. Parse AI decision (model may include reasoning text before the JSON)
  let decision: { decision: string; reasoning: string; confidence: number };
  try {
    decision = JSON.parse(aiResult.displayContent);
  } catch {
    // Try to extract JSON object from the response (model often prepends reasoning)
    const jsonMatch = aiResult.displayContent.match(/\{[\s\S]*"decision"[\s\S]*"reasoning"[\s\S]*"confidence"[\s\S]*\}/);
    if (jsonMatch) {
      decision = JSON.parse(jsonMatch[0]);
    } else {
      throw new Error(`Failed to parse AI response: ${aiResult.displayContent}`);
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
    nonce,
    evidenceCid,
  );

  // 8. Submit on-chain decision
  let decisionTx: { txHash: Hex };
  const result: EvaluateResult = {
    decision: decision.decision,
    reasoning: decision.reasoning,
    confidence: decision.confidence,
    commitment,
    evidenceSubmitTx: submitTx.txHash,
    decisionTx: "0x" as Hex, // placeholder, set below
  };

  if (meetsThreshold) {
    decisionTx = await arbiter.approveRefundRequest(paymentInfo, nonce);
    result.decisionTx = decisionTx.txHash;

    // Execute refund in escrow if approved
    try {
      const refundTx = await arbiter.executeRefundInEscrow(paymentInfo);
      result.refundTx = refundTx.txHash;
    } catch (refundErr) {
      console.warn("Refund execution failed (may already be settled):", refundErr);
      result.refundError = String(refundErr);
    }
  } else {
    decisionTx = await arbiter.denyRefundRequest(paymentInfo, nonce);
    result.decisionTx = decisionTx.txHash;
  }

  return result;
}

// --- Evaluate dispute endpoint ---
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

    const result = await evaluateDispute(paymentInfo, nonceBI);

    // Mark as evaluated
    const disputeKey = `${piHash}-${nonceBI}`;
    evaluatedDisputes.add(disputeKey);

    res.json(result);
  } catch (err) {
    console.error("Evaluate error:", err);
    res.status(500).json({ error: String(err) });
  }
});

// --- List disputes (globally ordered newest-first from on-chain events) ---
app.get("/api/disputes", async (req, res) => {
  try {
    const offset = parseInt(req.query.offset?.toString() ?? "0", 10);
    const count = parseInt(req.query.count?.toString() ?? "20", 10);

    const total = orderedDisputeKeys.length;
    const page = orderedDisputeKeys.slice(offset, offset + count);

    res.json({
      keys: page,
      total: String(total),
      offset: String(offset),
      count: String(count),
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

    // Recompute commitment (must use displayContent to match evaluate endpoint)
    const replayCommitment = createCommitment(
      userPrompt,
      seed,
      aiResult.displayContent,
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
const INDEX_INTERVAL_MS = 15_000;

async function start() {
  // 1. Deploy operator if not provided
  if (!OPERATOR_ADDRESS) {
    try {
      OPERATOR_ADDRESS = await autoDeployOperator();
    } catch (err) {
      console.error("Failed to deploy operator:", err);
      console.log("Starting server without operator — fund the arbiter wallet and restart");
      console.log(`  Arbiter address: ${account.address}`);
    }
  }

  // 2. Initialize arbiter SDK (if operator available)
  if (OPERATOR_ADDRESS) {
    initArbiter(OPERATOR_ADDRESS);
  }

  // 3. Index existing disputes
  if (OPERATOR_ADDRESS) {
    await indexAndCachePaymentInfo();
  }

  // 4. Start HTTP server
  app.listen(PORT, () => {
    console.log(`x402r Arbiter (EigenCloud) listening on port ${PORT}`);
    console.log(`  Arbiter address: ${account.address}`);
    console.log(`  Network: ${networkId} (${chain.name})`);
    console.log(`  Operator: ${OPERATOR_ADDRESS ?? "not deployed (needs funding)"}`);
    console.log(`  Model: ${EIGENAI_MODEL}`);
    console.log(`  Confidence threshold: ${CONFIDENCE_THRESHOLD}`);
    console.log(`  PaymentInfos cached: ${paymentInfoCache.size}`);

    // Poll for new on-chain disputes
    if (OPERATOR_ADDRESS) {
      setInterval(() => {
        indexAndCachePaymentInfo().catch(() => {});
      }, INDEX_INTERVAL_MS);
    }
  });

  // 5. Poll indexed disputes for evidence and auto-evaluate
  //    Instead of decoding EvidenceSubmitted events (which had ABI issues),
  //    periodically check each indexed dispute's evidence via getAllEvidence()
  //    view calls. Simpler and guaranteed to work.
  if (OPERATOR_ADDRESS) {
    const AUTO_EVAL_POLL_MS = 15_000;

    console.log(`  Starting auto-evaluation poller (every ${AUTO_EVAL_POLL_MS / 1000}s)...`);

    setInterval(async () => {
      try {
        // Re-index to pick up new disputes
        await indexAndCachePaymentInfo();

        for (const [disputeKey, { paymentInfo, nonce }] of indexedDisputes) {
          if (evaluatedDisputes.has(disputeKey)) continue;

          const allEvidence = await arbiter.getAllEvidence(paymentInfo, nonce);
          const hasPayerEvidence = allEvidence.some((e) => e.role === 0);
          const hasReceiverEvidence = allEvidence.some((e) => e.role === 1);
          const hasArbiterEvidence = allEvidence.some((e) => e.role === 2);

          // Skip if arbiter already submitted (evaluated elsewhere, e.g. manual /api/evaluate)
          if (hasArbiterEvidence) {
            evaluatedDisputes.add(disputeKey);
            continue;
          }

          if (!hasPayerEvidence || !hasReceiverEvidence) continue;

          // Both parties have submitted — evaluate
          console.log(`[auto-eval] Both parties submitted evidence for ${disputeKey.slice(0, 20)}... — evaluating`);
          evaluatedDisputes.add(disputeKey);

          try {
            const result = await evaluateDispute(paymentInfo, nonce);
            console.log(`[auto-eval] Decision: ${result.decision} (confidence: ${result.confidence})`);
            console.log(`[auto-eval] Evidence tx: ${result.evidenceSubmitTx}`);
            console.log(`[auto-eval] Decision tx: ${result.decisionTx}`);
            if (result.refundTx) {
              console.log(`[auto-eval] Refund tx: ${result.refundTx}`);
            }
          } catch (err) {
            console.error(`[auto-eval] Failed to evaluate ${disputeKey.slice(0, 20)}...:`, err);
            evaluatedDisputes.delete(disputeKey);
          }
        }
      } catch (err) {
        console.error("[auto-eval] Poll error:", err);
      }
    }, AUTO_EVAL_POLL_MS);
  }
}

start();
