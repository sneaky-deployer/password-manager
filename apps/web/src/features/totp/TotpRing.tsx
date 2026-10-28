import { cn } from "../../lib/cn.ts";

const RADIUS = 16;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

interface TotpRingProps {
  /** Fraction of the period elapsed, in [0, 1). The arc shrinks as it grows. */
  progress: number;
  /** Amber instead of the brand colour. */
  expiring: boolean;
  /** Whole seconds left; shown in the middle and exposed as a (non-announcing) timer. */
  seconds?: number;
  /** Size and text classes, e.g. "size-12 text-sm". */
  className?: string;
}

/**
 * Circular countdown. The arc is drawn with SVG `stroke-dasharray` / `stroke-dashoffset`
 * attributes, which are not inline styles and so are allowed by the `style-src 'self'` CSP.
 * Without `seconds` it is a purely decorative mini ring.
 */
export function TotpRing({ progress, expiring, seconds, className }: TotpRingProps) {
  const timerProps =
    seconds === undefined
      ? { "aria-hidden": true as const }
      : { role: "timer", "aria-label": "Seconds until the code changes" };
  return (
    <div className={cn("relative shrink-0", className ?? "size-12")} {...timerProps}>
      <svg viewBox="0 0 36 36" className="size-full -rotate-90" fill="none" aria-hidden="true">
        <circle
          cx="18"
          cy="18"
          r={RADIUS}
          strokeWidth="3.5"
          className="stroke-slate-200 dark:stroke-slate-700"
        />
        <circle
          cx="18"
          cy="18"
          r={RADIUS}
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * Math.min(1, Math.max(0, progress))}
          className={cn(
            "ease-linear",
            // No sweep back to full when a new period starts.
            progress < 0.05 ? "transition-none" : "transition-[stroke-dashoffset] duration-300",
            expiring ? "stroke-amber-500" : "stroke-brand-600 dark:stroke-brand-400",
          )}
        />
      </svg>
      {seconds === undefined ? null : (
        <span
          className={cn(
            "absolute inset-0 flex items-center justify-center font-semibold tabular-nums",
            expiring ? "text-amber-700 dark:text-amber-400" : "text-slate-800 dark:text-slate-200",
          )}
        >
          {seconds}
        </span>
      )}
    </div>
  );
}
