"use client";

import Link from "next/link";
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
  return (
    <Link
      href={`/dispute/${compositeKey}`}
      className="block border border-border bg-card hover:bg-white/[0.06] transition-colors p-4"
    >
      <div className="flex items-center justify-between gap-4">
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
        <div className="shrink-0">
          <StatusBadge status={status} />
        </div>
      </div>
    </Link>
  );
}
