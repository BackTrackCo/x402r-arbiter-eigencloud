/**
 * CLI configuration — loads from ~/.x402r/config.json, .env, and env vars.
 * Priority: env vars > .env > config file > defaults
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface CliConfigFile {
  privateKey?: string;
  operatorAddress?: string;
  arbiterUrl?: string;
  networkId?: string;
  rpcUrl?: string;
  pinataApiKey?: string;
  pinataSecretKey?: string;
}

const CONFIG_DIR = path.join(os.homedir(), ".x402r");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

/**
 * Load config from ~/.x402r/config.json
 */
export function loadConfigFile(): CliConfigFile {
  if (!fs.existsSync(CONFIG_FILE)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Save config to ~/.x402r/config.json
 */
export function saveConfigFile(config: CliConfigFile): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  // Merge with existing config
  const existing = loadConfigFile();
  const merged = { ...existing, ...config };
  // Remove undefined/null values
  for (const key of Object.keys(merged)) {
    if (merged[key as keyof CliConfigFile] === undefined || merged[key as keyof CliConfigFile] === null) {
      delete merged[key as keyof CliConfigFile];
    }
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
}

/**
 * Get resolved config: env vars > .env > config file > defaults
 */
export function getConfig(): Required<Pick<CliConfigFile, "networkId" | "arbiterUrl">> & CliConfigFile {
  const file = loadConfigFile();

  return {
    privateKey: process.env.PRIVATE_KEY || file.privateKey,
    operatorAddress: process.env.OPERATOR_ADDRESS || file.operatorAddress,
    arbiterUrl: process.env.ARBITER_URL || file.arbiterUrl || "http://localhost:3000",
    networkId: process.env.NETWORK_ID || file.networkId || "eip155:8453",
    rpcUrl: process.env.RPC_URL || file.rpcUrl,
    pinataApiKey: process.env.PINATA_API_KEY || file.pinataApiKey,
    pinataSecretKey: process.env.PINATA_SECRET_KEY || file.pinataSecretKey,
  };
}

/**
 * Print current config (masked key)
 */
export function printConfig(): void {
  const config = getConfig();
  console.log("\n=== x402r CLI Config ===");
  console.log("  Private Key:", config.privateKey ? `${config.privateKey.slice(0, 6)}...${config.privateKey.slice(-4)}` : "(not set)");
  console.log("  Operator:", config.operatorAddress || "(not set)");
  console.log("  Arbiter URL:", config.arbiterUrl);
  console.log("  Network:", config.networkId);
  console.log("  RPC URL:", config.rpcUrl || "(chain default)");
  console.log("  Pinata API Key:", config.pinataApiKey ? `${config.pinataApiKey.slice(0, 8)}...` : "(not set)");
  console.log(`\n  Config file: ${CONFIG_FILE}`);
}
