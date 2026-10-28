import { type ReactNode, useId } from "react";
import { cn } from "../../lib/cn.ts";

/** Props to spread onto the control inside a `Field`. */
export interface FieldControlProps {
  id: string;
  "aria-describedby": string | undefined;
  "aria-invalid": true | undefined;
  "aria-required": true | undefined;
}

interface FieldProps {
  label: ReactNode;
  /** Error text; also makes the control `aria-invalid` and is announced to screen readers. */
  error?: string | null | undefined;
  hint?: ReactNode;
  required?: boolean;
  className?: string;
  children: (control: FieldControlProps) => ReactNode;
}

/**
 * Label + control + hint + error with all the aria wiring:
 *   <Field label="Email" error={err}>{(c) => <Input {...c} />}</Field>
 */
export function Field({ label, error, hint, required, className, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ");
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={id} className="block text-sm font-medium text-slate-800 dark:text-slate-200">
        {label}
      </label>
      {children({
        id,
        "aria-describedby": describedBy || undefined,
        "aria-invalid": error ? true : undefined,
        "aria-required": required ? true : undefined,
      })}
      {hint ? (
        <p id={hintId} className="text-xs text-slate-600 dark:text-slate-400">
          {hint}
        </p>
      ) : null}
      <p
        id={errorId}
        role={error ? "alert" : undefined}
        className={error ? "text-xs font-medium text-red-700 dark:text-red-400" : "hidden"}
      >
        {error}
      </p>
    </div>
  );
}
