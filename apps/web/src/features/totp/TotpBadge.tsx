import { useEffect, useRef, useState } from "react";
import { copyWithAutoClear } from "../../lib/clipboard.ts";
import { cn } from "../../lib/cn.ts";
import { TotpRing } from "./TotpRing.tsx";
import { useTotp } from "./useTotp.ts";

export interface TotpBadgeProps {
  /** Full `otpauth://` URI (or a bare Base32 secret). */
  uri: string;
}

/** Compact list-view widget: current code plus a mini ring. Click copies the raw digits (auto-cleared after 30 s). */
export function TotpBadge({ uri }: TotpBadgeProps) {
  const totp = useTotp(uri);
  const [feedback, setFeedback] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  if (totp.status === "empty") return null;
  if (totp.status === "invalid") {
    return <span className="text-xs text-red-700 dark:text-red-400">Invalid code setup</span>;
  }

  async function copy(code: string) {
    try {
      await copyWithAutoClear(code);
      setFeedback("copied");
    } catch {
      setFeedback("failed");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setFeedback("idle"), 2000);
  }

  return (
    <>
      <button
        type="button"
        title="Click to copy"
        aria-label="Copy one-time code"
        onClick={(event) => {
          // The badge usually sits inside a clickable list row.
          event.stopPropagation();
          void copy(totp.code);
        }}
        className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2 py-1 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-brand-600 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
      >
        <span
          data-testid="totp-badge-code"
          className={cn(
            "font-mono text-sm font-semibold tabular-nums tracking-wider",
            totp.expiringSoon
              ? "text-amber-600 dark:text-amber-400"
              : "text-slate-900 dark:text-slate-100",
          )}
        >
          {feedback === "copied"
            ? "Copied"
            : feedback === "failed"
              ? "Copy failed"
              : totp.formatted}
        </span>
        <TotpRing progress={totp.progress} expiring={totp.expiringSoon} className="size-5" />
      </button>
      <span className="sr-only" role="status">
        {feedback === "copied"
          ? "Code copied. The clipboard is cleared in 30 seconds."
          : feedback === "failed"
            ? "Copy failed."
            : ""}
      </span>
    </>
  );
}
