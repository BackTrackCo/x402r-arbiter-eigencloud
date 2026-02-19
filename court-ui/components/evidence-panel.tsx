"use client";

import { useState } from "react";
import { Separator } from "@/components/ui/separator";
import { truncateAddress, roleLabel } from "@/lib/utils";
import { fetchEvidenceContent, tryParseJson } from "@/lib/ipfs";
import type { EvidenceEntry } from "@/lib/contracts";

interface EvidencePanelProps {
  entries: EvidenceEntry[];
}

function EvidenceRow({ entry, index }: { entry: EvidenceEntry; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleExpand = async () => {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (content !== null) return;
    setLoading(true);
    try {
      const text = await fetchEvidenceContent(entry.cid);
      setContent(text);
    } catch (err) {
      setContent(`Error: ${err instanceof Error ? err.message : "Failed to fetch"}`);
    } finally {
      setLoading(false);
    }
  };

  const role = roleLabel(entry.role);
  const isArbiter = entry.role === 2;
  const timestamp = new Date(Number(entry.timestamp) * 1000).toISOString();

  const parsed = content ? tryParseJson(content) : null;
  const commitment = isArbiter && parsed && typeof parsed === "object" ? parsed : null;

  return (
    <div className="border border-border">
      <button
        onClick={handleExpand}
        className="w-full text-left p-3 hover:bg-white/[0.03] transition-colors"
      >
        <div className="flex items-center gap-4 text-xs">
          <span className="text-muted-foreground w-6">#{index}</span>
          <span className="uppercase tracking-wider w-20 font-medium">
            {role}
          </span>
          <span className="text-muted-foreground flex-1">
            {truncateAddress(entry.submitter as string)}
          </span>
          <span className="text-muted-foreground">{timestamp}</span>
          <span className="text-muted-foreground">{expanded ? "−" : "+"}</span>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-border p-3">
          {loading ? (
            <p className="text-xs text-muted-foreground">Fetching from IPFS...</p>
          ) : commitment ? (
            <div className="space-y-2 text-xs">
              {"decision" in commitment ? (
                <div>
                  <span className="text-muted-foreground uppercase tracking-wider">
                    DECISION:{" "}
                  </span>
                  <span className="font-medium">
                    {String(commitment.decision).toUpperCase()}
                  </span>
                </div>
              ) : null}
              {"confidence" in commitment ? (
                <div>
                  <span className="text-muted-foreground uppercase tracking-wider">
                    CONFIDENCE:{" "}
                  </span>
                  <span>{String(commitment.confidence)}</span>
                </div>
              ) : null}
              {"model" in commitment ? (
                <div>
                  <span className="text-muted-foreground uppercase tracking-wider">
                    MODEL:{" "}
                  </span>
                  <span>{String(commitment.model)}</span>
                </div>
              ) : null}
              {"commitment" in commitment && commitment.commitment && typeof commitment.commitment === "object" ? (
                <>
                  <Separator />
                  <div className="space-y-1">
                    <p className="text-muted-foreground uppercase tracking-wider">
                      COMMITMENT
                    </p>
                    {Object.entries(commitment.commitment as Record<string, unknown>).map(
                      ([key, value]) => (
                        <div key={key} className="flex gap-2">
                          <span className="text-muted-foreground shrink-0">
                            {key}:
                          </span>
                          <span className="break-all">{String(value)}</span>
                        </div>
                      ),
                    )}
                  </div>
                </>
              ) : null}
              {"reasoning" in commitment && commitment.reasoning ? (
                <>
                  <Separator />
                  <div>
                    <p className="text-muted-foreground uppercase tracking-wider mb-1">
                      REASONING
                    </p>
                    <p className="whitespace-pre-wrap text-muted-foreground/80">
                      {String(commitment.reasoning)}
                    </p>
                  </div>
                </>
              ) : null}
            </div>
          ) : (
            <div className="text-xs">
              <p className="text-muted-foreground uppercase tracking-wider mb-1">
                CID: {entry.cid}
              </p>
              {content && (
                <pre className="whitespace-pre-wrap text-muted-foreground/80 mt-2 max-h-64 overflow-y-auto">
                  {content}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function EvidencePanel({ entries }: EvidencePanelProps) {
  if (entries.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">No evidence submitted yet.</p>
    );
  }

  return (
    <div className="space-y-1">
      {entries.map((entry, i) => (
        <EvidenceRow key={i} entry={entry} index={i} />
      ))}
    </div>
  );
}
