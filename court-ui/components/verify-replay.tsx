"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { CommitmentCard } from "@/components/commitment-card";
import { verifyDispute, type Commitment } from "@/lib/api";

interface VerifyReplayProps {
  paymentInfo: Record<string, unknown> | null;
  nonce: string;
  originalCommitment: Commitment | null;
}

export function VerifyReplay({ paymentInfo, nonce, originalCommitment }: VerifyReplayProps) {
  const [loading, setLoading] = useState(false);
  const [replayCommitment, setReplayCommitment] = useState<Commitment | null>(null);
  const [reasoning, setReasoning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleReplay = useCallback(async () => {
    if (!paymentInfo || !nonce) return;
    setLoading(true);
    setError(null);
    try {
      const result = await verifyDispute(paymentInfo, nonce);
      setReplayCommitment(result.replayCommitment);
      setReasoning(result.displayContent);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setLoading(false);
    }
  }, [paymentInfo, nonce]);

  const match =
    originalCommitment &&
    replayCommitment &&
    originalCommitment.commitmentHash === replayCommitment.commitmentHash;

  return (
    <div className="space-y-4">
      {!paymentInfo && (
        <p className="text-xs text-muted-foreground">
          Load PaymentInfo on the dispute detail page first.
        </p>
      )}

      <Button
        onClick={handleReplay}
        disabled={loading || !paymentInfo || !nonce}
        variant="outline"
        className="text-xs uppercase tracking-wider"
      >
        {loading ? "Replaying..." : "Replay Arbiter Decision"}
      </Button>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {replayCommitment && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {originalCommitment && (
              <CommitmentCard label="ORIGINAL COMMITMENT" commitment={originalCommitment} />
            )}
            <CommitmentCard label="REPLAY COMMITMENT" commitment={replayCommitment} />
          </div>

          {originalCommitment && (
            <div className="border border-border p-4">
              <p className="text-xs uppercase tracking-wider mb-1">
                HASH COMPARISON
              </p>
              <p className={`text-sm font-semibold ${match ? "text-white" : "text-destructive"}`}>
                {match ? "MATCH — Ruling is deterministic and verified" : "MISMATCH — Ruling could not be reproduced"}
              </p>
            </div>
          )}

          {reasoning && (
            <>
              <Separator />
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">
                  AI REASONING
                </p>
                <pre className="text-xs whitespace-pre-wrap text-muted-foreground/80 border border-border p-3 max-h-96 overflow-y-auto">
                  {reasoning}
                </pre>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
