import { HOTP, Secret } from "otpauth";
import type { OtpConfig } from "./types.ts";

/** RFC 6238 time step: floor(unixSeconds / period). */
export function timeStep(period: number, timeMs: number): number {
  return Math.max(0, Math.floor(timeMs / (period * 1000)));
}

/**
 * Code for an explicit time step (counter). With period 30 and timeStep = counter this is exactly
 * RFC 4226 HOTP. Throws if `config.secret` is not valid Base32.
 */
export function generateTotpAt(config: OtpConfig, step: number): string {
  const hotp = new HOTP({
    secret: Secret.fromBase32(config.secret),
    algorithm: config.algorithm,
    digits: config.digits,
    counter: step,
  });
  return hotp.generate();
}

/** Current zero-padded code. `timeMs` defaults to `Date.now()`. */
export function generateTotp(config: OtpConfig, timeMs: number = Date.now()): string {
  return generateTotpAt(config, timeStep(config.period, timeMs));
}

/** The code for the following period (shown in the last seconds of the current one). */
export function nextCode(config: OtpConfig, timeMs: number = Date.now()): string {
  return generateTotpAt(config, timeStep(config.period, timeMs) + 1);
}

/** Whole seconds left in the current period, in 1..period (never 0). */
export function secondsRemaining(period: number, timeMs: number = Date.now()): number {
  return period - (Math.floor(timeMs / 1000) % period);
}

/** Fraction of the current period elapsed, in [0, 1), with sub-second precision. */
export function progress(period: number, timeMs: number = Date.now()): number {
  const periodMs = period * 1000;
  return (((timeMs % periodMs) + periodMs) % periodMs) / periodMs;
}

/** True when the displayed seconds-remaining is at or below the threshold (default 5). */
export function isExpiringSoon(
  period: number,
  timeMs: number = Date.now(),
  thresholdSeconds = 5,
): boolean {
  return secondsRemaining(period, timeMs) <= thresholdSeconds;
}

/** "123456" -> "123 456", "1234567" -> "123 4567", "12345678" -> "1234 5678". */
export function formatCode(code: string): string {
  const split = Math.floor(code.length / 2);
  if (code.length < 4) return code;
  return code.length % 2 === 0
    ? `${code.slice(0, split)} ${code.slice(split)}`
    : `${code.slice(0, 3)} ${code.slice(3)}`;
}
