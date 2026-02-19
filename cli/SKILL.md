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
npx @x402r/cli <command>
```

Or install globally:

```bash
npm install -g @x402r/cli
```

## First-Time Setup

Before using any commands, configure the CLI with the user's wallet and operator:

```bash
x402r config --key <private-key> --operator <operator-address> --arbiter-url <arbiter-server-url>
```

- `--key`: The user's Ethereum private key (0x-prefixed). Stored in `~/.x402r/config.json`.
- `--operator`: The PaymentOperator contract address for the marketplace.
- `--arbiter-url`: URL of the arbiter server (e.g., `https://arbiter.example.com`). Defaults to `http://localhost:3000`.
- `--network`: Network ID in EIP-155 format (default: `eip155:84532` for Base Sepolia).
- `--rpc`: Custom RPC URL (optional).

To view current config: `x402r config`

## Commands

### File a Dispute

Creates an on-chain refund request and submits evidence in one step:

```bash
x402r dispute "Service was not delivered as promised" --evidence "Paid for API access but received 503 errors for 3 hours"
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
x402r status
```

Options:
- `--id <compositeKey>`: Look up by composite key
- `-p, --payment-json <json>`: Payment info JSON
- `-n, --nonce <nonce>`: Nonce

Tries the arbiter server first, falls back to on-chain query. Returns: Pending, Approved, Denied, or Cancelled.

### List Disputes

```bash
x402r list
```

Options:
- `-r, --receiver <address>`: Filter by receiver address
- `--offset <n>`: Pagination offset (default: 0)
- `--count <n>`: Number of results (default: 20)

Lists disputes from the arbiter server with pagination.

### View Evidence

```bash
x402r show
```

Shows all evidence entries (payer, merchant, arbiter) for a dispute. Each entry shows: role, submitter address, timestamp, and CID.

Options:
- `-p, --payment-json <json>`: Payment info JSON
- `-n, --nonce <nonce>`: Nonce

### Verify Arbiter Ruling

```bash
x402r verify
```

Replays the arbiter's AI evaluation to verify the commitment hash matches. Shows:
- Commitment hash, prompt hash, response hash, seed
- The AI's decision, confidence, and reasoning

Options:
- `-p, --payment-json <json>`: Payment info JSON
- `-n, --nonce <nonce>`: Nonce

## Typical Workflow

1. User makes an HTTP 402 payment and receives poor service
2. `x402r dispute "reason" --evidence "details"` — files the dispute
3. `x402r status` — checks if the arbiter has ruled
4. `x402r show` — views all evidence from both parties and the arbiter
5. `x402r verify` — verifies the AI ruling was deterministic

## Important Notes

- The CLI saves state between commands. After `dispute`, you can run `status`, `show`, `verify` without re-specifying payment info.
- Evidence can be stored on IPFS (if Pinata keys are configured) or inline as JSON strings.
- The `verify` command requires the arbiter server to be running — it replays the AI evaluation server-side.
- All on-chain operations require ETH for gas on the configured network.
