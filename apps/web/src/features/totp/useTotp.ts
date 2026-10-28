import {
  formatCode,
  generateTotpAt,
  isWeakSecret,
  type OtpConfig,
  type OtpParseError,
  parseOtpInput,
  progress as progressOf,
  secondsRemaining as secondsRemainingOf,
  timeStep,
} from "@pm/otp";
import { useEffect, useMemo, useRef, useState } from "react";
import { clockTracker } from "../../lib/api.ts";

export type TotpOk = {
  status: "ok";
  /** Raw digits, e.g. "123456". This is what gets copied. */
  code: string;
  /** Grouped for reading, e.g. "123 456". */
  formatted: string;
  /** Code for the following period. */
  next: string;
  nextFormatted: string;
  /** Whole seconds left in the current period, 1..period. */
  secondsRemaining: number;
  /** Fraction of the period elapsed, in [0, 1). */
  progress: number;
  period: number;
  /** True in the last 5 seconds (for short periods, the last third of the period). */
  expiringSoon: boolean;
  issuer: string | undefined;
  label: string | undefined;
  /** Secret shorter than 128 bits: works, but the UI should warn. */
  weakSecret: boolean;
};

export type TotpState = TotpOk | { status: "invalid"; error: OtpParseError } | { status: "empty" };

export interface UseTotpOptions {
  /** Time source in ms. Defaults to `clockTracker.now()` (device clock corrected by API `Date` headers). */
  now?: () => number;
}

/** Longest gap between ticks: about 4 updates per second keeps the ring smooth and cheap. */
const TICK_MS = 250;

const defaultNow = () => clockTracker.now();

/** Seconds before expiry at which the next code is shown. */
function expiryThreshold(period: number): number {
  return period >= 15 ? 5 : Math.max(1, Math.floor(period / 3));
}

type Parsed =
  | { kind: "empty" }
  | { kind: "invalid"; error: OtpParseError }
  | { kind: "ok"; config: OtpConfig };

function parse(uri: string | undefined): Parsed {
  if (uri === undefined) return { kind: "empty" };
  const result = parseOtpInput(uri);
  if (result.ok) return { kind: "ok", config: result.config };
  return result.error === "empty" ? { kind: "empty" } : { kind: "invalid", error: result.error };
}

/**
 * Live TOTP code for an `otpauth://` URI (or bare Base32 secret).
 *
 * - The URI is parsed once per distinct value; codes are recomputed only when the time step changes.
 * - Ticks about 4 times a second and exactly at each period boundary, so the code flips on time.
 * - Pauses while the tab is hidden and resyncs immediately on `visibilitychange`.
 * - The secret is only read from `uri`; it is never logged or stored.
 */
export function useTotp(uri: string | undefined, options: UseTotpOptions = {}): TotpState {
  const nowRef = useRef(options.now ?? defaultNow);
  nowRef.current = options.now ?? defaultNow;

  const parsed = useMemo(() => parse(uri), [uri]);
  const config = parsed.kind === "ok" ? parsed.config : null;

  const [timeMs, setTimeMs] = useState(() => nowRef.current());

  useEffect(() => {
    if (!config) return;
    const periodMs = config.period * 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const stop = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const tick = () => {
      const now = nowRef.current();
      setTimeMs(now);
      const untilBoundary = periodMs - (((now % periodMs) + periodMs) % periodMs);
      timer = setTimeout(tick, Math.max(1, Math.min(TICK_MS, untilBoundary)));
    };
    const onVisibility = () => {
      stop();
      if (!document.hidden) tick();
    };

    if (!document.hidden) tick();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [config]);

  const step = config ? timeStep(config.period, timeMs) : 0;
  const codes = useMemo(() => {
    if (!config) return null;
    try {
      return { code: generateTotpAt(config, step), next: generateTotpAt(config, step + 1) };
    } catch {
      return null;
    }
  }, [config, step]);

  if (parsed.kind === "empty") return { status: "empty" };
  if (parsed.kind === "invalid") return { status: "invalid", error: parsed.error };
  if (!config || !codes) return { status: "invalid", error: "invalid_secret" };

  const secondsRemaining = secondsRemainingOf(config.period, timeMs);
  return {
    status: "ok",
    code: codes.code,
    formatted: formatCode(codes.code),
    next: codes.next,
    nextFormatted: formatCode(codes.next),
    secondsRemaining,
    progress: progressOf(config.period, timeMs),
    period: config.period,
    expiringSoon: secondsRemaining <= expiryThreshold(config.period),
    issuer: config.issuer,
    label: config.label,
    weakSecret: isWeakSecret(config),
  };
}
