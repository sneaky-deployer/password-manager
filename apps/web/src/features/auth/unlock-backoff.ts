/**
 * Exponential backoff for wrong unlock passwords (PLAN.md 10.3). The first two typos are free;
 * after that the wait doubles from 2 s up to 5 minutes. The state is in memory, so reloading
 * the page resets it (the real brake is the Argon2id cost of every guess).
 */
const FREE_ATTEMPTS = 2;
const MAX_DELAY_MS = 5 * 60_000;

export function unlockBackoffMs(failures: number): number {
  if (failures <= FREE_ATTEMPTS) return 0;
  return Math.min(2 ** (failures - FREE_ATTEMPTS) * 1000, MAX_DELAY_MS);
}

let failures = 0;
let blockedUntil = 0;

export function recordUnlockFailure(now = Date.now()): number {
  failures += 1;
  blockedUntil = now + unlockBackoffMs(failures);
  return blockedUntil;
}

export function resetUnlockBackoff(): void {
  failures = 0;
  blockedUntil = 0;
}

export function unlockBlockedUntil(): number {
  return blockedUntil;
}
