import { useEffect, useRef, useState } from "react";
import { CLIPBOARD_CLEAR_MS, copyWithAutoClear } from "../../lib/clipboard.ts";
import { Button, type ButtonProps } from "./Button.tsx";

interface CopyButtonProps extends Omit<ButtonProps, "onClick" | "children" | "value"> {
  /** The text to copy. Read at click time. */
  value: string | (() => string);
  label?: string;
  /** Set to false for non-secret values that should stay on the clipboard. */
  autoClear?: boolean;
}

/** Copies to the clipboard and clears it after 30 s (PLAN.md 14.4), announcing both politely. */
export function CopyButton({
  value,
  label = "Copy",
  autoClear = true,
  variant = "secondary",
  size = "sm",
  ...rest
}: CopyButtonProps) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    const text = typeof value === "function" ? value() : value;
    try {
      if (autoClear) await copyWithAutoClear(text);
      else await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2500);
  }

  return (
    <>
      <Button variant={variant} size={size} onClick={() => void copy()} {...rest}>
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
      </Button>
      <span className="sr-only" role="status">
        {state === "copied"
          ? autoClear
            ? `Copied. The clipboard is cleared in ${CLIPBOARD_CLEAR_MS / 1000} seconds.`
            : "Copied."
          : state === "failed"
            ? "Copy failed."
            : ""}
      </span>
    </>
  );
}
