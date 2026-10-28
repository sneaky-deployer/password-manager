import { selectedCharsets } from "./charsets.ts";
import { type PasswordOptions, resolvePasswordOptions } from "./options.ts";
import { cryptoUint32, randomInt, shuffle, type Uint32Source } from "./random.ts";

/**
 * Generates a random password. One character is picked from each selected set (so every selected
 * set is represented), the rest is filled from the union of the sets, then everything is shuffled.
 */
export function generatePassword(
  opts: Partial<PasswordOptions> = {},
  source: Uint32Source = cryptoUint32,
): string {
  const o = resolvePasswordOptions(opts);
  const sets = selectedCharsets(o, o.avoidAmbiguous);
  const union = sets.flat();
  const chars: string[] = sets.map((set) => set[randomInt(set.length, source)] as string);
  while (chars.length < o.length) {
    chars.push(union[randomInt(union.length, source)] as string);
  }
  return shuffle(chars, source).join("");
}
