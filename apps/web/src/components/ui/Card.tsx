import type { ReactNode } from "react";
import { cn } from "../../lib/cn.ts";

interface CardProps {
  title?: ReactNode;
  description?: ReactNode;
  /** Right-aligned header content, e.g. a badge or button. */
  actions?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  /** Heading level for the title; defaults to h2. */
  as?: "h2" | "h3";
}

export function Card({
  title,
  description,
  actions,
  children,
  footer,
  className,
  as: Heading = "h2",
}: CardProps) {
  return (
    <section
      className={cn(
        "rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900",
        className,
      )}
    >
      {title || actions ? (
        <header className="flex items-start justify-between gap-4 px-5 pt-5">
          <div>
            {title ? <Heading className="text-base font-semibold">{title}</Heading> : null}
            {description ? (
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{description}</p>
            ) : null}
          </div>
          {actions}
        </header>
      ) : null}
      {children ? <div className="space-y-4 px-5 py-5">{children}</div> : null}
      {footer ? (
        <footer className="rounded-b-xl border-t border-slate-200 bg-slate-50 px-5 py-3 dark:border-slate-800 dark:bg-slate-900/60">
          {footer}
        </footer>
      ) : null}
    </section>
  );
}
