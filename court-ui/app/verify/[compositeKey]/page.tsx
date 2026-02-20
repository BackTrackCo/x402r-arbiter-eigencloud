"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { PaymentInfoInput } from "@/components/payment-info-input";
import { CommitmentCard } from "@/components/commitment-card";
import { VerifyReplay } from "@/components/verify-replay";
import { StatusBadge } from "@/components/status-badge";
import { truncateHash, formatAmount } from "@/lib/utils";
import { fetchDispute, fetchPaymentInfo, type DisputeDetail, type Commitment } from "@/lib/api";
import { getEvidenceBatch } from "@/lib/contracts";
import { fetchEvidenceContent, tryParseJson } from "@/lib/ipfs";

export default function VerifyPage() {
  const params = useParams<{ compositeKey: string }>();
  const compositeKey = params.compositeKey;

  const [dispute, setDispute] = useState<DisputeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [paymentInfo, setPaymentInfo] = useState<Record<string, unknown> | null>(null);
  const [nonce, setNonce] = useState("");
  const [originalCommitment, setOriginalCommitment] = useState<Commitment | null>(null);
  const [commitmentLoading, setCommitmentLoading] = useState(false);
  const [paymentInfoResolved, setPaymentInfoResolved] = useState(false);

  const loadCommitment = useCallback(
    async (pi: Record<string, unknown>, n: string) => {
      setPaymentInfo(pi);
      setNonce(n);
      setCommitmentLoading(true);

      try {
        const result = await getEvidenceBatch(pi, BigInt(n));
        // find arbiter evidence (role = 2)
        const arbiterEvidence = result.entries.find((e) => e.role === 2);
        if (arbiterEvidence) {
          const content = await fetchEvidenceContent(arbiterEvidence.cid);
          const parsed = tryParseJson(content);
          if (parsed?.commitment && typeof parsed.commitment === "object") {
            setOriginalCommitment(parsed.commitment as Commitment);
          }
        }
      } catch {
        // may fail if no evidence yet
      } finally {
        setCommitmentLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!compositeKey) return;
    fetchDispute(compositeKey)
      .then(async (d) => {
        setDispute(d);
        setLoading(false);
        // Auto-load from server cache
        const cached = await fetchPaymentInfo(d.paymentInfoHash);
        if (cached) {
          loadCommitment(cached, d.nonce);
        }
        setPaymentInfoResolved(true);
      })
      .catch(() => setLoading(false));
  }, [compositeKey, loadCommitment]);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link
        href={`/dispute/${compositeKey}`}
        className="text-xs text-muted-foreground hover:text-foreground transition-colors uppercase tracking-wider"
      >
        &larr; Back to dispute
      </Link>

      {/* Header */}
      <section>
        <div className="flex items-center gap-3 mb-3">
          <h1 className="text-base font-semibold">
            Verify: {truncateHash(compositeKey)}
          </h1>
          {dispute && <StatusBadge status={dispute.status} />}
        </div>
        {dispute && (
          <p className="text-xs text-muted-foreground">
            Amount: {formatAmount(dispute.amount)} USDC
          </p>
        )}
      </section>

      <Separator />

      {/* PaymentInfo Input — only show if auto-load didn't find cached paymentInfo */}
      {!paymentInfo && !commitmentLoading && paymentInfoResolved && (
        <section>
          <h2 className="text-xs text-muted-foreground uppercase tracking-widest mb-3">
            PAYMENTINFO
          </h2>
          <p className="text-xs text-muted-foreground mb-3">
            Provide the PaymentInfo JSON to fetch the original arbiter commitment and replay the decision.
          </p>
          <PaymentInfoInput
            compositeKey={compositeKey}
            onSubmit={loadCommitment}
            loading={commitmentLoading}
          />
        </section>
      )}

      {/* Original Commitment */}
      {commitmentLoading && (
        <Skeleton className="h-32 w-full" />
      )}

      {originalCommitment && (
        <>
          <Separator />
          <section>
            <h2 className="text-xs text-muted-foreground uppercase tracking-widest mb-3">
              ORIGINAL COMMITMENT
            </h2>
            <CommitmentCard label="FROM ARBITER EVIDENCE" commitment={originalCommitment} />
          </section>
        </>
      )}

      {/* Replay */}
      {paymentInfo && (
        <>
          <Separator />
          <section>
            <h2 className="text-xs text-muted-foreground uppercase tracking-widest mb-3">
              REPLAY VERIFICATION
            </h2>
            <VerifyReplay
              paymentInfo={paymentInfo}
              nonce={nonce}
              originalCommitment={originalCommitment}
            />
          </section>
        </>
      )}
    </div>
  );
}
