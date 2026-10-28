import { useEffect, useId, useState } from "react";
import { Input } from "../../components/ui/index.ts";

interface RangeControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}

/**
 * Slider plus number input bound to the same value. The number box keeps a text draft so typing
 * "1" on the way to "12" works; out-of-range numbers are passed on (so the generator can explain
 * the problem) and clamped when the box loses focus.
 */
export function RangeControl({ label, value, min, max, onChange }: RangeControlProps) {
  const numberId = useId();
  const [draft, setDraft] = useState(String(value));

  useEffect(() => setDraft(String(value)), [value]);

  function commitDraft() {
    const n = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(n)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, Math.round(n)));
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  }

  return (
    <div className="space-y-1.5">
      <label htmlFor={numberId} className="block text-sm font-medium">
        {label}
      </label>
      <div className="flex items-center gap-3">
        <input
          type="range"
          aria-label={`${label} slider`}
          min={min}
          max={max}
          step={1}
          value={Math.min(max, Math.max(min, value))}
          onChange={(event) => onChange(Number(event.target.value))}
          className="h-2 min-w-0 flex-1 cursor-pointer accent-brand-600 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-600"
        />
        <Input
          id={numberId}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={draft}
          className="w-20 shrink-0"
          onChange={(event) => {
            const text = event.target.value;
            setDraft(text);
            const n = Number(text);
            if (text.trim() !== "" && Number.isFinite(n)) onChange(Math.trunc(n));
          }}
          onBlur={commitDraft}
        />
      </div>
    </div>
  );
}
