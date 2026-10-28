/** A source of uniformly distributed unsigned 32-bit integers. */
export type Uint32Source = () => number;

const UINT32_RANGE = 0x1_0000_0000;

/** Default source: one value from `crypto.getRandomValues` (Web Crypto, works in browsers and Workers). */
export const cryptoUint32: Uint32Source = () => {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] as number;
};

/**
 * Uniform random integer in `[0, maxExclusive)` using rejection sampling.
 *
 * Raw 32-bit values >= `limit` (the largest multiple of `maxExclusive` that fits in 2^32) are
 * discarded, so `value % maxExclusive` has no modulo bias. `source` is injectable for tests.
 */
export function randomInt(maxExclusive: number, source: Uint32Source = cryptoUint32): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > UINT32_RANGE) {
    throw new RangeError(
      `randomInt: maxExclusive must be an integer in [1, 2^32], got ${maxExclusive}`,
    );
  }
  if (maxExclusive === 1) return 0;
  const limit = UINT32_RANGE - (UINT32_RANGE % maxExclusive);
  for (;;) {
    const value = source();
    if (value < limit) return value % maxExclusive;
  }
}

/** Fisher-Yates shuffle. Returns a new array; the input is not modified. */
export function shuffle<T>(array: readonly T[], source: Uint32Source = cryptoUint32): T[] {
  const out = array.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1, source);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
