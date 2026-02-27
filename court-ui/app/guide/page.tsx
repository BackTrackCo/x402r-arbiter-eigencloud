"use client";

import { useEffect, useState } from "react";
import { Separator } from "@/components/ui/separator";
import { fetchHealth, type HealthResponse } from "@/lib/api";

const MERCHANT_URL = "https://x402r-test-merchant-production.up.railway.app";

interface ContractsResponse {
  chainId: number;
  rpcUrl: string;
  operatorAddress: string | null;
  arbiterAddress: string;
  escrowAddress: string;
  refundRequestAddress: string;
  evidenceAddress: string;
  usdcAddress: string;
}

const CHAIN_NAMES: Record<number, string> = {
  84532: "Base Sepolia",
  8453: "Base",
  11155111: "Ethereum Sepolia",
  1: "Ethereum",
};

export default function GuidePage() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [contracts, setContracts] = useState<ContractsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const arbiterUrl =
      process.env.NEXT_PUBLIC_ARBITER_URL || "/arbiter";

    Promise.allSettled([
      fetchHealth(),
      fetch(`${arbiterUrl}/api/contracts`).then((r) =>
        r.ok ? (r.json() as Promise<ContractsResponse>) : null,
      ),
    ]).then(([hResult, cResult]) => {
      if (hResult.status === "fulfilled") setHealth(hResult.value);
      if (cResult.status === "fulfilled" && cResult.value)
        setContracts(cResult.value);
      setLoading(false);
    });
  }, []);

  const operator =
    contracts?.operatorAddress ?? health?.operatorAddress ?? "loading...";
  const network = health
    ? `${CHAIN_NAMES[health.chainId] ?? health.network} (eip155:${health.chainId})`
    : "loading...";
  const arbiterAddr = health?.arbiterAddress ?? contracts?.arbiterAddress ?? "loading...";
  const arbiterUrl =
    typeof window !== "undefined" ? window.location.origin + "/arbiter" : "https://<your-arbiter>/arbiter";

  return (
    <div className="space-y-6">
      {/* Live Config */}
      <section>
        <h2 className="text-xs text-muted-foreground uppercase tracking-widest mb-3">
          LIVE CONFIG
          {loading && (
            <span className="ml-2 text-muted-foreground/60 normal-case">
              fetching...
            </span>
          )}
        </h2>
        <div className="border border-border p-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <Field label="MERCHANT" value={`${MERCHANT_URL}/weather`} mono />
            <Field label="PRICE" value="$0.01 USDC (escrow)" />
            <Field label="OPERATOR" value={operator} mono />
            <Field label="ARBITER ADDRESS" value={arbiterAddr} mono />
            <Field label="ARBITER URL" value={arbiterUrl} mono />
            <Field label="NETWORK" value={network} />
            {health && (
              <>
                <Field label="MODEL" value={health.model} />
                <Field
                  label="CONFIDENCE THRESHOLD"
                  value={String(health.confidenceThreshold)}
                />
              </>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Values fetched live from the arbiter&apos;s{" "}
            <span className="text-foreground">/health</span> and{" "}
            <span className="text-foreground">/api/contracts</span> endpoints.
          </p>
        </div>
      </section>

      <Separator />

      {/* Quick Test */}
      <section>
        <h2 className="text-xs text-muted-foreground uppercase tracking-widest mb-3">
          QUICK TEST
        </h2>
        <div className="border border-border p-4 space-y-2 text-xs">
          <p className="text-muted-foreground mb-2">
            Verify the merchant is online and returns payment requirements:
          </p>
          <Code>{`curl ${MERCHANT_URL}/weather`}</Code>
          <p className="text-muted-foreground mt-2">
            Should return HTTP 402 with escrow payment options.
          </p>
        </div>
      </section>

      <Separator />

      {/* API Reference */}
      <section>
        <h2 className="text-xs text-muted-foreground uppercase tracking-widest mb-3">
          API REFERENCE
        </h2>
        <div className="border border-border p-4 space-y-4 text-xs">
          <p className="text-muted-foreground mb-2">
            All endpoints are relative to the arbiter base URL.
          </p>

          <Endpoint method="GET" path="/health" desc="Status, model, threshold, network info" />
          <Code>{`curl ${arbiterUrl}/health`}</Code>

          <Endpoint method="GET" path="/api/contracts" desc="Contract addresses + chain config" />
          <Code>{`curl ${arbiterUrl}/api/contracts`}</Code>

          <Endpoint method="GET" path="/api/policy" desc="Evaluation policy (system prompt hash, model, threshold)" />

          <Endpoint method="POST" path="/api/payment-info" desc="Cache payment info for dashboard lookups" />

          <Endpoint method="GET" path="/api/payment-info/:hash" desc="Retrieve cached payment info by hash" />

          <Endpoint method="POST" path="/api/evaluate" desc="Trigger dispute evaluation (requires paymentInfo + nonce)" />

          <Endpoint method="GET" path="/api/disputes?offset=&count=" desc="List disputes (paginated, newest first)" />
          <Code>{`curl "${arbiterUrl}/api/disputes?offset=0&count=5"`}</Code>

          <Endpoint method="GET" path="/api/dispute/:compositeKey" desc="Dispute detail (status, amount, nonce)" />
        </div>
      </section>

      <Separator />

      {/* OpenClaw Bot Tutorial */}
      <section>
        <h2 className="text-xs text-muted-foreground uppercase tracking-widest mb-3">
          OPENCLAW BOT GUIDE
        </h2>
        <div className="border border-border p-4 space-y-6 text-xs">
          <p className="text-muted-foreground">
            The{" "}
            <span className="text-foreground font-semibold">x402r-dispute</span>{" "}
            skill is available on ClawHub. It lets an OpenClaw bot act as a
            client — paying the merchant, filing disputes, and tracking
            arbitration end-to-end.
          </p>

          <Step n={1} title="Install the skill">
            <p className="text-muted-foreground mb-3">OpenClaw / ClawHub</p>
            <Code>{`clawhub install x402r/x402r-dispute`}</Code>
            <p className="text-muted-foreground mt-3 mb-3">Manual</p>
            <Code>{`curl -s https://raw.githubusercontent.com/BackTrackCo/x402r-arbiter-eigencloud/main/cli/SKILL.md \\
  > ~/.openclaw/skills/x402r-dispute/SKILL.md`}</Code>
          </Step>

          <Step n={2} title="Configure your bot's wallet">
            <p className="text-muted-foreground mb-2">
              Tell your bot to set up the x402r config with these details:
            </p>
            <Code>{`Operator: ${operator}
Network:  ${network}
Arbiter:  ${arbiterUrl}
Merchant: ${MERCHANT_URL}/weather`}</Code>
            <p className="text-muted-foreground mt-2">
              The bot needs a funded wallet with USDC and ETH for gas.
              Config is persisted to{" "}
              <span className="text-foreground">~/.x402r/config.json</span>.
            </p>
          </Step>

          <Step n={3} title="Buy from the merchant">
            <p className="text-muted-foreground mb-2">
              Ask your bot to fetch the weather endpoint. The x402 payment
              flow is automatic — the bot sees the 402, signs an escrow
              payment, and retries:
            </p>
            <Code>{`"Buy weather data from ${MERCHANT_URL}/weather"`}</Code>
            <p className="text-muted-foreground mt-2">
              The payment goes into escrow. The bot receives the weather data
              and saves the payment info for later.
            </p>
          </Step>

          <Step n={4} title="File a dispute">
            <p className="text-muted-foreground mb-2">
              If the data was unsatisfactory, ask the bot to dispute:
            </p>
            <Code>{`"File a dispute — the weather data was inaccurate,
it said sunny but it was raining"`}</Code>
            <p className="text-muted-foreground mt-2">
              The bot uses the skill to create an on-chain refund request
              and submit evidence in one step.
            </p>
          </Step>

          <Step n={5} title="Merchant auto-responds">
            <p className="text-muted-foreground mb-2">
              The merchant dispute bot detects the refund request on-chain
              and automatically submits counter-evidence. No action needed —
              wait a few seconds.
            </p>
          </Step>

          <Step n={6} title="Arbiter evaluates">
            <p className="text-muted-foreground mb-2">
              The arbiter collects evidence from both sides, evaluates with
              a deterministic AI model, and submits its ruling on-chain.
              Ask your bot to check the result:
            </p>
            <Code>{`"Check my dispute status"
"Show all evidence for my dispute"
"Verify the arbiter's ruling was deterministic"`}</Code>
          </Step>

          <Step n={7} title="View on dashboard">
            <p className="text-muted-foreground mb-2">
              The dispute appears on the{" "}
              <a href="/" className="text-foreground underline underline-offset-2">
                disputes page
              </a>{" "}
              where you can inspect evidence, the arbiter&apos;s ruling,
              commitment hash, and replay the AI evaluation.
            </p>
          </Step>
        </div>
      </section>

      <Separator />

      {/* Flow Diagram */}
      <section>
        <h2 className="text-xs text-muted-foreground uppercase tracking-widest mb-3">
          END-TO-END FLOW
        </h2>
        <div className="border border-border p-4">
          <pre className="text-xs text-muted-foreground leading-relaxed overflow-x-auto">{`OpenClaw Bot                    Merchant Server          Merchant Bot          Arbiter
       |                            |                       |                    |
       |--- GET /weather ---------->|                       |                    |
       |<-- 402 (payment required) -|                       |                    |
       |--- GET /weather + payment->|                       |                    |
       |<-- 200 (weather data) -----|                       |                    |
       |                            |                       |                    |
       |--- dispute -------------> [on-chain: RefundRequested]                   |
       |                            |                       |                    |
       |                            |    (watches events)   |                    |
       |                            |<-- auto-evidence -----|                    |
       |                            |                       |                    |
       |                            |              [arbiter evaluates both sides] |
       |                            |                       |<--- ruling --------|
       |                            |                       |                    |
       |--- status / verify ------->|                       |                    |`}</pre>
        </div>
      </section>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="text-xs">
      <p className="text-muted-foreground uppercase tracking-wider mb-0.5">{label}</p>
      <p className={`font-medium ${mono ? "break-all" : ""}`}>{value}</p>
    </div>
  );
}

function Endpoint({ method, path, desc }: { method: string; path: string; desc: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 pt-2 first:pt-0">
      <span className="text-foreground font-semibold shrink-0">{method}</span>
      <span className="text-foreground break-all">{path}</span>
      <span className="text-muted-foreground">— {desc}</span>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-foreground mb-2">
        {n}. {title}
      </h3>
      {children}
    </div>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre className="bg-muted/50 border border-border rounded px-3 py-2 text-xs overflow-x-auto whitespace-pre-wrap">
      {children}
    </pre>
  );
}
