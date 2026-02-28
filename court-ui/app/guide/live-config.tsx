"use client";

import { useEffect, useState } from "react";
import { fetchHealth, type HealthResponse } from "@/lib/api";

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

export function LiveConfig({ merchantUrl }: { merchantUrl: string }) {
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
          <Field label="MERCHANT" value={`${merchantUrl}/weather`} mono />
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
