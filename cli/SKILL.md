---
name: x402r-dispute
description: File and track payment disputes on the x402r refundable payments protocol
version: 0.1.0
author: x402r
tags: [x402r, payments, disputes, web3, arbitration]
---

# x402r Dispute Resolution CLI

You help users file and track payment disputes on the x402r protocol. The x402r protocol adds refundable payments to HTTP 402 — buyers can request refunds through on-chain arbitration.

## Installation

The CLI is available via npx (no install needed):

```bash
npx --yes @x402r/cli <command>
```

Or install globally:

```bash
npm install -g @x402r/cli
```

> **Note:** If running inside a pnpm workspace, `npx` may fail due to workspace resolution. Use `npm install -g @x402r/cli` or run from an external directory instead.

## First-Time Setup

Before using any commands, configure the CLI with the user's wallet and operator:

```bash
npx --yes @x402r/cli config --key <private-key> --operator <operator-address> --arbiter-url <arbiter-server-url>
```

- `--key`: The user's Ethereum private key (0x-prefixed). Stored in `~/.x402r/config.json`.
- `--operator`: The PaymentOperator contract address for the marketplace.
- `--arbiter-url`: URL of the arbiter server (e.g., `https://arbiter.example.com`). Defaults to `http://localhost:3000`.
- `--network`: Network ID in EIP-155 format (default: `eip155:84532` for Base Sepolia).
- `--rpc`: Custom RPC URL (optional).

To view current config:

```bash
npx --yes @x402r/cli config
```

## Commands

### File a Dispute

Creates an on-chain refund request and submits evidence in one step:

```bash
npx --yes @x402r/cli dispute "Service was not delivered as promised" --evidence "Paid for API access but received 503 errors for 3 hours"
```

Options:
- First argument (required): The reason for the dispute
- `-e, --evidence <text>`: Additional evidence text
- `-f, --file <path>`: Path to a JSON file with structured evidence
- `-p, --payment-json <json>`: Payment info JSON (uses saved state from last payment if omitted)
- `-n, --nonce <nonce>`: Nonce for the refund request (default: 0)
- `-a, --amount <amount>`: Refund amount in token units (default: full payment amount)

The command saves dispute state to `~/.x402r/last-dispute.json` so subsequent commands can reference it.

### Check Dispute Status

```bash
npx --yes @x402r/cli status
```

Options:
- `--id <compositeKey>`: Look up by composite key
- `-p, --payment-json <json>`: Payment info JSON
- `-n, --nonce <nonce>`: Nonce

Tries the arbiter server first, falls back to on-chain query. Returns: Pending, Approved, Denied, Cancelled, or "No refund request found" if no dispute exists.

### List Disputes

```bash
npx --yes @x402r/cli list
```

Options:
- `-r, --receiver <address>`: Filter by receiver address
- `--offset <n>`: Pagination offset (default: 0)
- `--count <n>`: Number of results (default: 20)

Lists disputes from the arbiter server with pagination.

### View Evidence

```bash
npx --yes @x402r/cli show
```

Shows all evidence entries (payer, merchant, arbiter) for a dispute. Each entry shows: role, submitter address, timestamp, and evidence content. If Pinata is configured, the content field is an IPFS CID; otherwise, it contains the raw evidence JSON inline.

Options:
- `-p, --payment-json <json>`: Payment info JSON
- `-n, --nonce <nonce>`: Nonce

### Verify Arbiter Ruling

```bash
npx --yes @x402r/cli verify
```

Replays the arbiter's AI evaluation to verify the commitment hash matches. Shows:
- Commitment hash, prompt hash, response hash, seed
- The AI's decision, confidence, and reasoning

Options:
- `-p, --payment-json <json>`: Payment info JSON
- `-n, --nonce <nonce>`: Nonce

## Payment JSON Format

When using `--payment-json` to specify payment info directly (instead of relying on saved state), provide a JSON string with these fields:

```json
{
  "operator": "0x...",
  "payer": "0x...",
  "receiver": "0x...",
  "token": "0x...",
  "maxAmount": "10000",
  "preApprovalExpiry": "0",
  "authorizationExpiry": "1700000000",
  "refundExpiry": "1700100000"
}
```

All address fields are 0x-prefixed Ethereum addresses. Amount and timestamp fields are numeric strings. `maxAmount` is in the token's smallest unit (e.g., 10000 = 0.01 USDC with 6 decimals).

Example with a full command:

```bash
npx --yes @x402r/cli status --payment-json '{"operator":"0x<operator>","payer":"0x<payer>","receiver":"0x<receiver>","token":"0x<token>","maxAmount":"10000","preApprovalExpiry":"0","authorizationExpiry":"1700000000","refundExpiry":"1700100000"}' --nonce 0
```

## Typical Workflow

1. User makes an HTTP 402 payment and receives poor service
2. `npx --yes @x402r/cli dispute "reason" --evidence "details"` — files the dispute
3. `npx --yes @x402r/cli status` — checks if the arbiter has ruled
4. `npx --yes @x402r/cli show` — views all evidence from both parties and the arbiter
5. `npx --yes @x402r/cli verify` — verifies the AI ruling was deterministic

## Important Notes

- The CLI saves state between commands. After `dispute`, you can run `status`, `show`, `verify` without re-specifying payment info.
- If no saved state exists (no prior `dispute`), you must provide `--payment-json` and `--nonce` explicitly.
- Evidence can be stored on IPFS (if Pinata keys are configured via `--pinata-key` and `--pinata-secret` on `config`) or inline as JSON strings.
- The `verify` command requires the arbiter server to be running — it replays the AI evaluation server-side.
- All on-chain operations require ETH for gas on the configured network.

## Troubleshooting

- **"fetch failed" / arbiter unreachable**: The arbiter server may be down. Commands like `list` require the server; `status` and `show` fall back to on-chain queries automatically.
- **"No payment state found"**: Run `dispute` first to create saved state, or pass `--payment-json` directly.
- **Transaction reverts / insufficient gas**: Ensure the configured wallet has ETH on the target network for gas fees.
- **`verify` fails with "fetch failed"**: The `verify` command requires the arbiter server to be running. Unlike `status` and `show`, it has no on-chain fallback — it replays the AI evaluation server-side.
- **npx not found inside workspace**: If running in a pnpm monorepo, install globally with `npm install -g @x402r/cli` instead.
