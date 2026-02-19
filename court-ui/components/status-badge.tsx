"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const statusStyles: Record<number, string> = {
  0: "bg-muted text-muted-foreground border-border",
  1: "bg-white/10 text-white border-white/20",
  2: "bg-muted text-muted-foreground/70 border-border",
  3: "bg-muted text-muted-foreground/50 border-border",
};

const statusLabels: Record<number, string> = {
  0: "PENDING",
  1: "APPROVED",
  2: "DENIED",
  3: "CANCELLED",
};

export function StatusBadge({ status }: { status: number }) {
  return (
    <Badge
      variant="outline"
      className={cn("text-[10px] tracking-widest font-medium rounded-sm", statusStyles[status] ?? statusStyles[0])}
    >
      {statusLabels[status] ?? "UNKNOWN"}
    </Badge>
  );
}
