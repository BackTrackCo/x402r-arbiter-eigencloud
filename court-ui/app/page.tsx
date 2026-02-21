"use client";

import { useEffect, useState, useCallback } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { DisputeCard } from "@/components/dispute-card";
import { truncateAddress } from "@/lib/utils";
import {
  fetchHealth,
  fetchDisputes,
  fetchDispute,
  fetchPaymentInfo,
  type HealthResponse,
  type DisputeDetail,
} from "@/lib/api";
import { getEvidenceBatch } from "@/lib/contracts";

const PAGE_SIZE = 10;
const STALE_PENDING_S = 60; // seconds — hide pending disputes older than this

interface DisputeWithKey extends DisputeDetail {
  compositeKey: string;
}

/** For a pending dispute, fetch the first evidence entry's on-chain timestamp.
 *  Returns epoch seconds, or null if no evidence / paymentInfo unavailable. */
async function getDisputeCreatedAt(
  paymentInfoHash: string,
  nonce: string,
): Promise<number | null> {
  try {
    const pi = await fetchPaymentInfo(paymentInfoHash);
    if (!pi) return null;
    const { entries } = await getEvidenceBatch(pi, BigInt(nonce), 0n, 1n);
    if (entries.length === 0) return null;
    return Number(entries[0].timestamp);
  } catch {
    return null;
  }
}

export default function Dashboard() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [disputes, setDisputes] = useState<DisputeWithKey[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const poll = () =>
      fetchHealth()
        .then((h) => { setHealth(h); setHealthError(null); })
        .catch((err) => setHealthError(err.message));
    poll();
    const interval = setInterval(poll, 10000);
    return () => clearInterval(interval);
  }, []);

  const loadDisputes = useCallback(async (newOffset: number, background = false) => {
    if (!background) setLoading(true);
    try {
      const list = await fetchDisputes(newOffset, PAGE_SIZE);
      setOffset(newOffset);

      const details = await Promise.all(
        list.keys.map(async (key) => {
          const detail = await fetchDispute(key);
          return { ...detail, compositeKey: key };
        }),
      );

      // Resolved disputes always show. For pending ones, check on-chain age.
      const nowS = Math.floor(Date.now() / 1000);
      const visible: DisputeWithKey[] = [];

      for (const d of details) {
        if (d.status !== 0) {
          visible.push(d);
          continue;
        }
        // Pending — check first evidence timestamp on-chain
        const createdAt = await getDisputeCreatedAt(d.paymentInfoHash, d.nonce);
        if (createdAt !== null && nowS - createdAt < STALE_PENDING_S) {
          visible.push(d);
        }
      }

      setTotal(visible.length);
      setDisputes(visible);
    } catch {
      // arbiter server may be offline
    } finally {
      if (!background) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDisputes(0);
  }, [loadDisputes]);

  useEffect(() => {
    const interval = setInterval(() => loadDisputes(offset, true), 5000);
    return () => clearInterval(interval);
  }, [loadDisputes, offset]);

  return (
    <div className="space-y-6">
      {/* Arbiter Status */}
      <section>
        <h2 className="text-xs text-muted-foreground uppercase tracking-widest mb-3">
          ARBITER STATUS
        </h2>
        {healthError ? (
          <div className="border border-border p-3 text-xs text-muted-foreground">
            Arbiter offline — {healthError}
          </div>
        ) : health ? (
          <div className="border border-border p-3 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <Field label="ADDRESS" value={truncateAddress(health.arbiterAddress)} />
            <Field label="MODEL" value={health.model} />
            <Field label="THRESHOLD" value={String(health.confidenceThreshold)} />
            <Field label="NETWORK" value={health.network} />
          </div>
        ) : (
          <Skeleton className="h-16 w-full" />
        )}
      </section>

      <Separator />

      {/* Disputes List */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs text-muted-foreground uppercase tracking-widest">
            DISPUTES {total > 0 && `(${total})`}
          </h2>
        </div>

        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : disputes.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No disputes found. The arbiter server may be offline or no disputes have been filed.
          </p>
        ) : (
          <div className="space-y-1">
            {disputes.map((d) => (
              <DisputeCard
                key={d.compositeKey}
                compositeKey={d.compositeKey}
                paymentInfoHash={d.paymentInfoHash}
                status={d.status}
                amount={d.amount}
                nonce={d.nonce}
              />
            ))}
          </div>
        )}

        {/* Pagination */}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between mt-4 text-xs">
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0}
              onClick={() => loadDisputes(Math.max(0, offset - PAGE_SIZE))}
              className="text-xs uppercase tracking-wider"
            >
              Previous
            </Button>
            <span className="text-muted-foreground">
              {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => loadDisputes(offset + PAGE_SIZE)}
              className="text-xs uppercase tracking-wider"
            >
              Next
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-muted-foreground uppercase tracking-wider mb-0.5">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  );
}
