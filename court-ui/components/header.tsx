"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchHealth } from "@/lib/api";

const CHAIN_NAMES: Record<number, string> = {
  84532: "Base Sepolia",
  8453: "Base",
  11155111: "Ethereum Sepolia",
  1: "Ethereum",
};

export function Header() {
  const [network, setNetwork] = useState("");

  useEffect(() => {
    fetchHealth()
      .then((h) => setNetwork(CHAIN_NAMES[h.chainId] ?? h.network))
      .catch(() => setNetwork("Offline"));
  }, []);

  return (
    <header className="border-b border-border">
      <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-base font-semibold tracking-tight">
            MoltArbiter
          </Link>
          <Link
            href="/guide"
            className="text-xs text-muted-foreground uppercase tracking-widest hover:text-foreground transition-colors"
          >
            Guide
          </Link>
        </div>
        <span className="text-xs text-muted-foreground uppercase tracking-widest">
          {network}
        </span>
      </div>
    </header>
  );
}
