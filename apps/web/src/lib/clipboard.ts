/** Clipboard auto-clear after 30 s (PLAN.md 14.4). Best effort: browsers restrict clipboard access. */
export const CLIPBOARD_CLEAR_MS = 30_000;

let clearTimer: ReturnType<typeof setTimeout> | null = null;
let focusRetry: (() => void) | null = null;

function cancelScheduled(): void {
  if (clearTimer !== null) clearTimeout(clearTimer);
  clearTimer = null;
  if (focusRetry) window.removeEventListener("focus", focusRetry);
  focusRetry = null;
}

/** True/false when we could read the clipboard, null when reading is not allowed (no prompt). */
async function clipboardStillHolds(text: string): Promise<boolean | null> {
  try {
    const status = await navigator.permissions?.query({ name: "clipboard-read" as PermissionName });
    if (status?.state !== "granted") return null;
    return (await navigator.clipboard.readText()) === text;
  } catch {
    return null;
  }
}

async function clearIfOurs(text: string): Promise<boolean> {
  if (!document.hasFocus()) return false;
  const holds = await clipboardStillHolds(text);
  // Someone copied something else meanwhile: leave it alone.
  if (holds === false) return true;
  // Unreadable clipboard (null): we cannot tell, and a leftover secret is the bigger risk.
  try {
    await navigator.clipboard.writeText("");
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy `text` and schedule it to be cleared after `clearAfterMs`. The clear only runs while the
 * page has focus (the Clipboard API requires it); if the page is in the background the clear
 * is retried when it regains focus. A newer copy cancels the older timer.
 */
export async function copyWithAutoClear(
  text: string,
  clearAfterMs: number = CLIPBOARD_CLEAR_MS,
): Promise<void> {
  await navigator.clipboard.writeText(text);
  cancelScheduled();
  clearTimer = setTimeout(() => {
    clearTimer = null;
    void clearIfOurs(text).then((done) => {
      if (done) return;
      const retry = () => {
        window.removeEventListener("focus", retry);
        focusRetry = null;
        void clearIfOurs(text);
      };
      focusRetry = retry;
      window.addEventListener("focus", retry);
    });
  }, clearAfterMs);
}
