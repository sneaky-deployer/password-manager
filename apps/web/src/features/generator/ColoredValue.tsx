import { cn } from "../../lib/cn.ts";

type CharClass = "digit" | "symbol" | "letter";

const CLASS_STYLES: Record<CharClass, string> = {
  letter: "text-slate-900 dark:text-slate-100",
  digit: "text-sky-700 dark:text-sky-300",
  symbol: "text-rose-700 dark:text-rose-300",
};

function classify(char: string): CharClass {
  if (/\d/.test(char)) return "digit";
  if (/[\p{L}\s]/u.test(char)) return "letter";
  return "symbol";
}

type Segment = { start: number; cls: CharClass; text: string };

/** Groups consecutive characters of the same class so the DOM stays small. */
export function segmentValue(value: string): Segment[] {
  const segments: Segment[] = [];
  let index = 0;
  for (const char of value) {
    const cls = classify(char);
    const last = segments[segments.length - 1];
    if (last && last.cls === cls) last.text += char;
    else segments.push({ start: index, cls, text: char });
    index += char.length;
  }
  return segments;
}

/** Monospace rendering with digits and symbols coloured, so a password is easy to read aloud or copy by eye. */
export function ColoredValue({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  return (
    <figure
      aria-label={label}
      data-testid="generator-output"
      className={cn(
        "m-0 min-h-14 select-all whitespace-pre-wrap break-all rounded-lg border border-slate-200 bg-slate-50 px-3 py-3 font-mono leading-relaxed dark:border-slate-700 dark:bg-slate-950",
        className,
      )}
    >
      {segmentValue(value).map((segment) => (
        <span key={segment.start} className={CLASS_STYLES[segment.cls]}>
          {segment.text}
        </span>
      ))}
    </figure>
  );
}
