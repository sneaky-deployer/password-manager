import { cn } from "../../lib/cn.ts";

interface SpinnerProps {
  /** Screen reader text. Pass `""` when the surrounding control already says what is happening. */
  label?: string;
  className?: string;
}

export function Spinner({ label = "Loading", className }: SpinnerProps) {
  return (
    <span role={label ? "status" : undefined} className="inline-flex items-center">
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className={cn("size-5 animate-spin text-current motion-reduce:animate-none", className)}
        fill="none"
      >
        <circle
          cx="12"
          cy="12"
          r="9"
          stroke="currentColor"
          strokeWidth="3"
          className="opacity-25"
        />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
