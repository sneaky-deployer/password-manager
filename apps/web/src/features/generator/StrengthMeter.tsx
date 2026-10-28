import type { Strength } from "@pm/generator";
import { cn } from "../../lib/cn.ts";

const LABELS: Record<Strength, string> = {
  weak: "Weak",
  fair: "Fair",
  strong: "Strong",
  "very-strong": "Very strong",
};

const FILLED: Record<Strength, number> = { weak: 1, fair: 2, strong: 3, "very-strong": 4 };

const COLORS: Record<Strength, string> = {
  weak: "bg-red-500",
  fair: "bg-amber-500",
  strong: "bg-lime-500",
  "very-strong": "bg-emerald-500",
};

export function strengthLabel(strength: Strength): string {
  return LABELS[strength];
}

/** Four-segment meter with the label and entropy; the text is a polite live region. */
export function StrengthMeter({ strength, bits }: { strength: Strength; bits: number }) {
  return (
    <div className="space-y-1.5" data-testid="generator-strength">
      <div className="flex gap-1" aria-hidden="true">
        {[1, 2, 3, 4].map((segment) => (
          <span
            key={segment}
            className={cn(
              "h-1.5 flex-1 rounded-full",
              segment <= FILLED[strength] ? COLORS[strength] : "bg-slate-200 dark:bg-slate-700",
            )}
          />
        ))}
      </div>
      <p aria-live="polite" className="text-xs text-slate-600 dark:text-slate-400">
        Strength: <span className="font-medium">{LABELS[strength]}</span> ({bits.toFixed(1)} bits of
        entropy)
      </p>
    </div>
  );
}
