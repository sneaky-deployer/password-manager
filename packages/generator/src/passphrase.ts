import { type PassphraseOptions, resolvePassphraseOptions } from "./options.ts";
import { cryptoUint32, randomInt, type Uint32Source } from "./random.ts";
import { EFF_LARGE_WORDLIST } from "./wordlists/eff-large.ts";

/** Generates a passphrase of random EFF large-wordlist words. */
export function generatePassphrase(
  opts: Partial<PassphraseOptions> = {},
  source: Uint32Source = cryptoUint32,
): string {
  const o = resolvePassphraseOptions(opts);
  const words: string[] = [];
  for (let i = 0; i < o.words; i++) {
    const word = EFF_LARGE_WORDLIST[randomInt(EFF_LARGE_WORDLIST.length, source)] as string;
    words.push(o.capitalize ? word.charAt(0).toUpperCase() + word.slice(1) : word);
  }
  if (o.includeNumber) {
    const i = randomInt(words.length, source);
    words[i] = `${words[i]}${randomInt(10, source)}`;
  }
  let out = words[0] as string;
  for (let i = 1; i < words.length; i++) {
    const sep = o.separator === "digit" ? String(randomInt(10, source)) : o.separator;
    out += sep + words[i];
  }
  return out;
}
