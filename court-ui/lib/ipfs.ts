const PINATA_GATEWAY = "https://gateway.pinata.cloud/ipfs";

/**
 * Check if a string looks like a real IPFS CID (CIDv0 or CIDv1).
 * CIDv0: starts with "Qm", exactly 46 base58 chars (no underscores/special chars).
 * CIDv1: starts with "bafy".
 */
export function isIpfsCid(s: string): boolean {
  if (s.startsWith("bafy")) return true;
  if (s.startsWith("Qm") && s.length === 46 && /^[A-Za-z0-9]+$/.test(s))
    return true;
  return false;
}

/**
 * Resolve evidence content from a CID string.
 * If the string is valid JSON or not a real IPFS CID, return it directly.
 * Otherwise fetch from IPFS gateway.
 */
export async function fetchEvidenceContent(cid: string): Promise<string> {
  // If it parses as JSON, it's inline evidence (e.g. arbiter commitment)
  try {
    JSON.parse(cid);
    return cid;
  } catch {
    // not JSON — continue
  }

  // If it looks like a real IPFS CID, fetch from gateway
  if (isIpfsCid(cid)) {
    const res = await fetch(`${PINATA_GATEWAY}/${cid}`);
    if (!res.ok) throw new Error(`IPFS fetch failed: ${res.status}`);
    return res.text();
  }

  // Otherwise return the raw string as-is (inline text evidence)
  return cid;
}

/** @deprecated Use fetchEvidenceContent instead */
export async function fetchIpfsContent(cid: string): Promise<string> {
  return fetchEvidenceContent(cid);
}

export function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
