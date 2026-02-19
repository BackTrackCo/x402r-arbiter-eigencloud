"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { StatusBadge } from "@/components/status-badge";
import { PaymentInfoInput } from "@/components/payment-info-input";
import { EvidencePanel } from "@/components/evidence-panel";
import { truncateHash, formatAmount } from "@/lib/utils";
import { fetchDispute, fetchPaymentInfo, type DisputeDetail } from "@/lib/api";
import { getEvidenceBatch, type EvidenceEntry } from "@/lib/contracts";

export default function DisputeDetailPage() {
  const params = useParams<{ compositeKey: string }>();
  const compositeKey = params.compositeKey;

  const [dispute, setDispute] = useState<DisputeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [evidence, setEvidence] = useState<EvidenceEntry[] | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);

  const loadEvidence = useCallback(
    async (paymentInfo: Record<string, unknown>, nonce: string) => {
      setEvidenceLoading(true);
      setEvidenceError(null);
      try {
        const result = await getEvidenceBatch(paymentInfo, BigInt(nonce));
        setEvidence(result.entries);
      } catch (err) {
        setEvidenceError(
          err instanceof Error ? err.message : "Failed to load evidence",
        );
      } finally {
        setEvidenceLoading(false);
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
        // Auto-load evidence if server has cached paymentInfo
        const cached = await fetchPaymentInfo(d.paymentInfoHash);
        if (cached) {
          loadEvidence(cached, d.nonce);
        }
      })
      .catch(() => setLoading(false));
  }, [compositeKey, loadEvidence]);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!dispute) {
    return (
      <p className="text-xs text-muted-foreground">
        Dispute not found. The arbiter server may be offline.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {/* Back link */}
      <Link
        href="/"
        className="text-xs text-muted-foreground hover:text-foreground transition-colors uppercase tracking-wider"
      >
        &larr; Back to disputes
      </Link>

      {/* Metadata */}
      <section>
        <div className="flex items-center gap-3 mb-3">
          <h1 className="text-base font-semibold">
            {truncateHash(compositeKey)}
          </h1>
          <StatusBadge status={dispute.status} />
        </div>

        <div className="border border-border p-4 grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          <div>
            <p className="text-muted-foreground uppercase tracking-wider mb-0.5">
              PAYMENT INFO HASH
            </p>
            <p className="break-all">{dispute.paymentInfoHash}</p>
          </div>
          <div>
            <p className="text-muted-foreground uppercase tracking-wider mb-0.5">
              NONCE
            </p>
            <p>{dispute.nonce}</p>
          </div>
          <div>
            <p className="text-muted-foreground uppercase tracking-wider mb-0.5">
              AMOUNT
            </p>
            <p>{formatAmount(dispute.amount)} USDC</p>
          </div>
          <div>
            <p className="text-muted-foreground uppercase tracking-wider mb-0.5">
              ACTIONS
            </p>
            <Link
              href={`/verify/${compositeKey}`}
              className="text-white underline underline-offset-2 hover:text-white/80"
            >
              Verify Ruling
            </Link>
          </div>
        </div>
      </section>

      <Separator />

      {/* Evidence Loading — only show manual input if auto-load didn't find cached paymentInfo */}
      {!evidence && !evidenceLoading && (
        <section>
          <h2 className="text-xs text-muted-foreground uppercase tracking-widest mb-3">
            LOAD EVIDENCE
          </h2>
          <p className="text-xs text-muted-foreground mb-3">
            Evidence reads require the full PaymentInfo tuple. Paste the JSON below to fetch on-chain evidence.
          </p>
          <PaymentInfoInput
            compositeKey={compositeKey}
            onSubmit={loadEvidence}
            loading={evidenceLoading}
          />
          {evidenceError && (
            <p className="text-xs text-destructive mt-2">{evidenceError}</p>
          )}
        </section>
      )}

      {/* Evidence Display */}
      {evidence && (
        <>
          <Separator />
          <section>
            <h2 className="text-xs text-muted-foreground uppercase tracking-widest mb-3">
              EVIDENCE ({evidence.length})
            </h2>
            <EvidencePanel entries={evidence} />
          </section>
        </>
      )}
    </div>
  );
}
