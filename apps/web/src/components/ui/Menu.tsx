import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { cn } from "../../lib/cn.ts";

export interface MenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  tone?: "default" | "danger";
}

interface MenuProps {
  /** Accessible name and visible content of the trigger button. */
  label: string;
  trigger: ReactNode;
  items: MenuItem[];
  align?: "left" | "right";
}

/** Small dropdown menu: Escape and outside click close it, arrow keys move between items. */
export function Menu({ label, trigger, items, align = "right" }: MenuProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        root.current?.querySelector<HTMLButtonElement>("button[aria-haspopup]")?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function moveFocus(direction: 1 | -1) {
    const buttons = [
      ...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
    ];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(index + direction + buttons.length) % buttons.length]?.focus();
  }

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-brand-600 dark:hover:bg-slate-800"
      >
        {trigger}
      </button>
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              moveFocus(1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              moveFocus(-1);
            }
          }}
          className={cn(
            "absolute z-30 mt-1 min-w-48 rounded-lg border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={cn(
                "block w-full rounded-md px-3 py-2 text-left text-sm focus-visible:bg-slate-100 focus-visible:outline-none dark:focus-visible:bg-slate-800",
                item.tone === "danger"
                  ? "text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950"
                  : "hover:bg-slate-100 dark:hover:bg-slate-800",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
