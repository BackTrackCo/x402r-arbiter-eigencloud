"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/status-badge";
import { truncateHash, formatAmount } from "@/lib/utils";

interface DisputeCardProps {
  compositeKey: string;
  paymentInfoHash: string;
  status: number;
  amount: string;
  nonce: string;
}

export function DisputeCard({ compositeKey, paymentInfoHash, status, amount }: DisputeCardProps) {
  const router = useRouter();

  return (
    <Link
      href={`/dispute/${compositeKey}`}
      className="block border border-border bg-card hover:bg-white/[0.06] transition-colors p-4"
    >
      {/* Mobile: stacked layout */}
      <div className="flex flex-col gap-3 sm:hidden">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-0.5">
              DISPUTE
            </p>
            <p className="text-sm truncate">{truncateHash(compositeKey)}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <StatusBadge status={status} />
            {(status === 1 || status === 2) && (
              <button
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  router.push(`/verify/${compositeKey}`);
                }}
                className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
              >
                Verify
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-0.5">
              PAYMENT
            </p>
            <p className="text-sm truncate">{truncateHash(paymentInfoHash)}</p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-0.5">
              AMOUNT
            </p>
            <p className="text-sm">{formatAmount(amount)} USDC</p>
          </div>
        </div>
      </div>

      {/* Desktop: single row */}
      <div className="hidden sm:flex items-center justify-between gap-4">
        <div className="flex-1 min-w-0">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
            DISPUTE
          </p>
          <p className="text-sm truncate">{truncateHash(compositeKey)}</p>
        </div>
        <div className="shrink-0">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
            PAYMENT
          </p>
          <p className="text-sm">{truncateHash(paymentInfoHash)}</p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">
            AMOUNT
          </p>
          <p className="text-sm">{formatAmount(amount)} USDC</p>
        </div>
        <div className="shrink-0 flex items-center gap-3">
          <StatusBadge status={status} />
          {(status === 1 || status === 2) && (
            <button
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                router.push(`/verify/${compositeKey}`);
              }}
              className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
            >
              Verify
            </button>
          )}
        </div>
      </div>
    </Link>
  );
}
