import { type InputHTMLAttributes, type ReactNode, useId } from "react";

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "children"> {
  label: ReactNode;
  description?: ReactNode;
}

export function Checkbox({ label, description, id, ...rest }: CheckboxProps) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <div className="flex items-start gap-3">
      <input
        id={inputId}
        type="checkbox"
        className="mt-0.5 size-4 rounded border-slate-300 accent-brand-600 focus-visible:outline-2 focus-visible:outline-brand-600"
        {...rest}
      />
      <label htmlFor={inputId} className="text-sm text-slate-800 dark:text-slate-200">
        {label}
        {description ? (
          <span className="block text-xs text-slate-600 dark:text-slate-400">{description}</span>
        ) : null}
      </label>
    </div>
  );
}
