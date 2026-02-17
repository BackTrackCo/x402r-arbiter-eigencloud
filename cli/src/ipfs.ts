/**
 * IPFS pinning via Pinata API.
 * Falls back to inline string if no Pinata key configured.
 */

import { getConfig } from "./config.js";

interface PinataResponse {
  IpfsHash: string;
  PinSize: number;
  Timestamp: string;
}

/**
 * Pin JSON to IPFS via Pinata.
 * Returns IPFS CID if Pinata configured, otherwise returns JSON string directly.
 */
export async function pinToIpfs(data: Record<string, unknown>): Promise<string> {
  const config = getConfig();

  if (!config.pinataApiKey || !config.pinataSecretKey) {
    console.log("  (No Pinata key — storing evidence as inline string)");
    return JSON.stringify(data);
  }

  console.log("  Pinning to IPFS via Pinata...");

  const response = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      pinata_api_key: config.pinataApiKey,
      pinata_secret_api_key: config.pinataSecretKey,
    },
    body: JSON.stringify({
      pinataContent: data,
      pinataMetadata: {
        name: `x402r-evidence-${Date.now()}`,
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.warn(`  Pinata failed (${response.status}): ${text}`);
    console.log("  Falling back to inline string");
    return JSON.stringify(data);
  }

  const result = (await response.json()) as PinataResponse;
  console.log(`  Pinned: ${result.IpfsHash}`);
  return result.IpfsHash;
}
