// When deployed on Vercel, requests go through Next.js rewrites (/arbiter/* → backend).
// For local dev, NEXT_PUBLIC_ARBITER_URL can point directly at the arbiter.
const ARBITER_URL = process.env.NEXT_PUBLIC_ARBITER_URL || "/arbiter";

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
  const res = await fetch(`${ARBITER_URL}/health`);
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
  const res = await fetch(`${ARBITER_URL}/api/disputes?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch disputes: ${res.status}`);
  return res.json();
}

export async function fetchDispute(compositeKey: string): Promise<DisputeDetail> {
  const res = await fetch(`${ARBITER_URL}/api/dispute/${compositeKey}`);
  if (!res.ok) throw new Error(`Failed to fetch dispute: ${res.status}`);
  return res.json();
}

export async function fetchPaymentInfo(
  paymentInfoHash: string,
): Promise<Record<string, unknown> | null> {
  const res = await fetch(
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
  const res = await fetch(`${ARBITER_URL}/api/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paymentInfo, nonce }),
  });
  if (!res.ok) throw new Error(`Verification failed: ${res.status}`);
  return res.json();
}
