import type { ReactNode } from "react";

interface Props {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  /** Wider card for screens such as the recovery kit. */
  wide?: boolean;
}

/** Centered card used by every signed-out page. */
export function AuthLayout({ title, subtitle, children, wide = false }: Props) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <div className={wide ? "w-full max-w-2xl" : "w-full max-w-md"}>
        <div className="mb-6 flex items-center justify-center gap-2 text-brand-700 dark:text-brand-300">
          <LogoMark />
          <span className="text-lg font-semibold">Password Manager</span>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8 dark:border-slate-800 dark:bg-slate-900">
          <h1 className="text-xl font-semibold">{title}</h1>
          {subtitle ? (
            <div className="mt-1 text-sm text-slate-600 dark:text-slate-400">{subtitle}</div>
          ) : null}
          <div className="mt-6 space-y-4">{children}</div>
        </div>
      </div>
    </div>
  );
}

export function LogoMark({ className = "size-7" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" />
      <circle cx="12" cy="11" r="1.8" />
      <path d="M12 12.8V16" />
    </svg>
  );
}
