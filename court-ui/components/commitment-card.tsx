"use client";

import type { Commitment } from "@/lib/api";

interface CommitmentCardProps {
  label: string;
  commitment: Commitment;
}

export function CommitmentCard({ label, commitment }: CommitmentCardProps) {
  return (
    <div className="border border-border p-4 space-y-3">
      <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium">
        {label}
      </p>
      <div className="space-y-2 text-xs">
        <Field label="PROMPT HASH" value={commitment.promptHash} />
        <Field label="RESPONSE HASH" value={commitment.responseHash} />
        <Field label="COMMITMENT HASH" value={commitment.commitmentHash} />
        <Field label="SEED" value={String(commitment.seed)} />
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-muted-foreground tracking-wider">{label}: </span>
      <span className="break-all">{value}</span>
    </div>
  );
}
