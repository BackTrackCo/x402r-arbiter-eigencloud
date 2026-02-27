// When deployed on Vercel, requests go through Next.js rewrites (/arbiter/* → backend).
// For local dev, NEXT_PUBLIC_ARBITER_URL can point directly at the arbiter.
const ARBITER_URL = process.env.NEXT_PUBLIC_ARBITER_URL || "/arbiter";

/** Fetch with retry on 429/500 (up to 3 attempts with exponential backoff) */
async function fetchWithRetry(input: RequestInfo, init?: RequestInit, maxRetries = 3): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(input, init);
    if (res.status === 429 || res.status >= 500) {
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
    }
    return res;
  }
  return fetch(input, init); // unreachable but satisfies TS
}

export interface HealthResponse {
  status: string;
  arbiterAddress: string;
  network: string;
  chainId: number;
  model: string;
  seed: number;
  confidenceThreshold: number;
  operatorAddress: string;
}

export interface DisputeListResponse {
  keys: string[];
  total: string;
  offset: string;
  count: string;
}

export interface DisputeDetail {
  paymentInfoHash: string;
  nonce: string;
  amount: string;
  status: number;
}

export interface Commitment {
  promptHash: string;
  responseHash: string;
  commitmentHash: string;
  seed: number;
}

export interface VerifyResponse {
  replayCommitment: Commitment;
  displayContent: string;
  note: string;
}

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetchWithRetry(`${ARBITER_URL}/health`);
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
  return res.json();
}

export async function fetchDisputes(
  offset = 0,
  count = 20,
  receiver?: string,
): Promise<DisputeListResponse> {
  const params = new URLSearchParams({
    offset: String(offset),
    count: String(count),
  });
  if (receiver) params.set("receiver", receiver);
  const res = await fetchWithRetry(`${ARBITER_URL}/api/disputes?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch disputes: ${res.status}`);
  return res.json();
}

export async function fetchDispute(compositeKey: string): Promise<DisputeDetail> {
  const res = await fetchWithRetry(`${ARBITER_URL}/api/dispute/${compositeKey}`);
  if (!res.ok) throw new Error(`Failed to fetch dispute: ${res.status}`);
  return res.json();
}

export async function fetchPaymentInfo(
  paymentInfoHash: string,
): Promise<Record<string, unknown> | null> {
  const res = await fetchWithRetry(
    `${ARBITER_URL}/api/payment-info/${paymentInfoHash}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to fetch payment info: ${res.status}`);
  return res.json();
}

export async function verifyDispute(
  paymentInfo: Record<string, unknown>,
  nonce: string,
): Promise<VerifyResponse> {
  // Call court-ui's own /api/verify route — independent of the arbiter
  const res = await fetchWithRetry("/api/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paymentInfo, nonce }),
  });
  if (!res.ok) throw new Error(`Verification failed: ${res.status}`);
  return res.json();
}

export async function pinEvidence(
  data: Record<string, unknown>,
): Promise<{ cid: string }> {
  // Pin via court-ui's own /api/pin route — independent of the arbiter
  const res = await fetchWithRetry("/api/pin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Pin failed: ${res.status}`);
  return res.json();
}
