/**
 * IPFS pinning — tries Pinata JWT first, then arbiter's /api/pin endpoint,
 * then falls back to a pre-pinned placeholder CID.
 */

import { getConfig } from "./config.js";

/**
 * Pin JSON to IPFS.
 * 1. Pinata JWT (if configured)
 * 2. Arbiter /api/pin endpoint (free for clients)
 * 3. Placeholder CID fallback
 */
export async function pinToIpfs(data: Record<string, unknown>): Promise<string> {
  const config = getConfig();

  // 1. Direct Pinata
  if (config.pinataJwt) {
    console.log("  Pinning to IPFS via Pinata...");
    try {
      const response = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.pinataJwt}`,
        },
        body: JSON.stringify({
          pinataContent: data,
          pinataMetadata: { name: `x402r-evidence-${Date.now()}` },
        }),
      });
      if (response.ok) {
        const result = (await response.json()) as { IpfsHash: string };
        console.log(`  Pinned: ${result.IpfsHash}`);
        return result.IpfsHash;
      }
      console.warn(`  Pinata failed (${response.status})`);
    } catch (err) {
      console.warn(`  Pinata error:`, err instanceof Error ? err.message : err);
    }
  }

  // 2. Arbiter pin endpoint
  const arbiterUrl = config.arbiterUrl;
  console.log(`  Pinning via arbiter (${arbiterUrl}/api/pin)...`);
  try {
    const response = await fetch(`${arbiterUrl}/api/pin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (response.ok) {
      const result = (await response.json()) as { cid: string };
      console.log(`  Pinned: ${result.cid}`);
      return result.cid;
    }
    const text = await response.text();
    console.warn(`  Arbiter pin failed (${response.status}): ${text}`);
  } catch (err) {
    console.warn(`  Arbiter pin error:`, err instanceof Error ? err.message : err);
  }

  // 3. Placeholder fallback
  console.log("  (Using placeholder CID)");
  return "QmXyxi3LYRb33bThaHLtotFxcG4FXnDowC2d5EjwYqE4iR";
}
