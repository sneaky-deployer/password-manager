export type ClockOffsetTracker = {
  /** Record a sample from an HTTP `Date` header. Null/unparseable headers and negative RTTs are ignored. */
  addSample(serverDateHeader: string | null, requestStartMs: number, responseEndMs: number): void;
  /** Median of the recorded offsets (server - device) in ms; 0 when there are no samples. */
  offsetMs(): number;
  /** True when |offset| exceeds the threshold (default 10 s). */
  shouldApply(thresholdMs?: number): boolean;
  /** `Date.now() + offset` when the offset should be applied, otherwise `Date.now()`. */
  now(): number;
};

/**
 * Estimates device clock skew from the `Date` header of API responses.
 *
 * Each sample assumes the server stamped the response at the midpoint of the request. The HTTP
 * `Date` header has 1-second resolution (it is truncated, not rounded), so the effective precision
 * is about +-1 s. That is fine for a 10 s correction threshold and a 30 s TOTP window.
 */
export function createClockOffsetTracker(
  options: { maxSamples?: number; thresholdMs?: number } = {},
): ClockOffsetTracker {
  const maxSamples = Math.max(1, Math.floor(options.maxSamples ?? 5));
  const samples: number[] = [];

  function offsetMs(): number {
    if (samples.length === 0) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
    return Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2);
  }

  function shouldApply(thresholdMs: number = options.thresholdMs ?? 10_000): boolean {
    return Math.abs(offsetMs()) > thresholdMs;
  }

  return {
    addSample(serverDateHeader, requestStartMs, responseEndMs) {
      if (!serverDateHeader) return;
      const serverMs = Date.parse(serverDateHeader);
      if (!Number.isFinite(serverMs)) return;
      if (!Number.isFinite(requestStartMs) || !Number.isFinite(responseEndMs)) return;
      if (responseEndMs < requestStartMs) return;
      const midpoint = (requestStartMs + responseEndMs) / 2;
      samples.push(serverMs - midpoint);
      if (samples.length > maxSamples) samples.shift();
    },
    offsetMs,
    shouldApply,
    now() {
      return shouldApply() ? Date.now() + offsetMs() : Date.now();
    },
  };
}
