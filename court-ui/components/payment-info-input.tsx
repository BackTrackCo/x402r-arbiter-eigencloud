"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";

const STORAGE_KEY = "x402r-court-paymentInfo";

function loadStored(compositeKey: string): { raw: string; nonce: string } {
  if (typeof window === "undefined") return { raw: "", nonce: "" };
  try {
    const stored = localStorage.getItem(`${STORAGE_KEY}:${compositeKey}`);
    if (stored) {
      const parsed = JSON.parse(stored);
      return {
        raw: JSON.stringify(parsed.paymentInfo, null, 2),
        nonce: parsed.nonce || "",
      };
    }
  } catch {
    // ignore
  }
  return { raw: "", nonce: "" };
}

interface PaymentInfoInputProps {
  compositeKey: string;
  onSubmit: (paymentInfo: Record<string, unknown>, nonce: string) => void;
  loading?: boolean;
}

export function PaymentInfoInput({ compositeKey, onSubmit, loading }: PaymentInfoInputProps) {
  const [raw, setRaw] = useState(() => loadStored(compositeKey).raw);
  const [nonce, setNonce] = useState(() => loadStored(compositeKey).nonce);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(() => {
    setError(null);
    try {
      const paymentInfo = JSON.parse(raw);
      if (!paymentInfo.operator || !paymentInfo.payer || !paymentInfo.receiver) {
        setError("Missing required fields (operator, payer, receiver)");
        return;
      }
      localStorage.setItem(
        `${STORAGE_KEY}:${compositeKey}`,
        JSON.stringify({ paymentInfo, nonce }),
      );
      onSubmit(paymentInfo, nonce);
    } catch {
      setError("Invalid JSON");
    }
  }, [raw, nonce, compositeKey, onSubmit]);

  return (
    <div className="space-y-3">
      <div>
        <label className="text-xs text-muted-foreground uppercase tracking-wider block mb-1">
          PAYMENTINFO JSON
        </label>
        <textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder='{"operator": "0x...", "payer": "0x...", ...}'
          className="w-full h-48 bg-black border border-border p-3 text-xs resize-y focus:outline-none focus:border-white/25"
          spellCheck={false}
        />
      </div>
      <div>
        <label className="text-xs text-muted-foreground uppercase tracking-wider block mb-1">
          NONCE
        </label>
        <input
          type="text"
          value={nonce}
          onChange={(e) => setNonce(e.target.value)}
          placeholder="0"
          className="w-full bg-black border border-border p-2 text-xs focus:outline-none focus:border-white/25"
        />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button
        onClick={handleSubmit}
        disabled={loading || !raw.trim() || !nonce.trim()}
        variant="outline"
        className="text-xs uppercase tracking-wider"
      >
        {loading ? "Loading..." : "Load Evidence"}
      </Button>
    </div>
  );
}
