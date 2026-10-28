import { cn } from "../../lib/cn.ts";
import { assessPassword, MIN_PASSWORD_LENGTH } from "./password-policy.ts";

const SEGMENT_COLORS = [
  "bg-red-500",
  "bg-orange-500",
  "bg-amber-500",
  "bg-lime-500",
  "bg-emerald-500",
] as const;

interface Props {
  password: string;
  userInputs?: string[];
}

/** Strength bar (zxcvbn) plus the two rules the form enforces. */
export function PasswordStrengthMeter({ password, userInputs }: Props) {
  const assessment = assessPassword(password, userInputs);
  const filled = password ? assessment.score + 1 : 0;
  return (
    <div className="space-y-1.5" data-testid="strength-meter">
      <div className="flex gap-1" aria-hidden="true">
        {SEGMENT_COLORS.map((color, i) => (
          <span
            key={color}
            className={cn(
              "h-1.5 flex-1 rounded-full",
              i < filled ? color : "bg-slate-200 dark:bg-slate-700",
            )}
          />
        ))}
      </div>
      <p className="text-xs text-slate-600 dark:text-slate-400">
        {password ? (
          <>
            Strength: <span className="font-medium">{assessment.label}</span>
            {assessment.warning ? ` — ${assessment.warning}` : ""}
          </>
        ) : (
          `Use at least ${MIN_PASSWORD_LENGTH} characters. A few unrelated words make a strong password.`
        )}
      </p>
      {password ? (
        <ul className="text-xs text-slate-600 dark:text-slate-400">
          <li>
            {assessment.longEnough ? "Done: " : "Needed: "}at least {MIN_PASSWORD_LENGTH} characters
          </li>
          <li>{assessment.strongEnough ? "Done: " : "Needed: "}strength Good or better</li>
        </ul>
      ) : null}
    </div>
  );
}
