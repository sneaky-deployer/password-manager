const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;
/** Ignore bursts of events (mouse moves) closer together than this. */
const THROTTLE_MS = 1000;

export interface AutoLockOptions {
  /** Idle minutes before `onLock` runs. */
  minutes: number;
  onLock: () => void;
  target?: Window;
}

/**
 * Calls `onLock` once after `minutes` without pointer or keyboard activity. Returns a stop
 * function. Also re-checks when the tab becomes visible again, because timers can be paused
 * while a laptop sleeps.
 */
export function startAutoLock({ minutes, onLock, target = window }: AutoLockOptions): () => void {
  const idleMs = minutes * 60_000;
  let lastActivity = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fired = false;

  function fire(): void {
    if (fired) return;
    fired = true;
    onLock();
  }

  function schedule(): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(fire, idleMs);
  }

  function onActivity(): void {
    const now = Date.now();
    if (now - lastActivity < THROTTLE_MS) return;
    lastActivity = now;
    schedule();
  }

  function onVisible(): void {
    if (target.document.visibilityState === "visible" && Date.now() - lastActivity >= idleMs)
      fire();
  }

  for (const name of ACTIVITY_EVENTS) target.addEventListener(name, onActivity, { passive: true });
  target.document.addEventListener("visibilitychange", onVisible);
  target.addEventListener("focus", onVisible);
  schedule();

  return () => {
    if (timer !== null) clearTimeout(timer);
    for (const name of ACTIVITY_EVENTS) target.removeEventListener(name, onActivity);
    target.document.removeEventListener("visibilitychange", onVisible);
    target.removeEventListener("focus", onVisible);
  };
}
