export const LOWERCASE = "abcdefghijklmnopqrstuvwxyz";
export const UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const DIGITS = "0123456789";
export const SYMBOLS = "!@#$%^&*()-_=+[]{};:,.?/";
/** Characters that are easy to confuse; removed from every set when `avoidAmbiguous` is on. */
export const AMBIGUOUS = "0Oo1lI|";

export type CharsetToggles = {
  lowercase: boolean;
  uppercase: boolean;
  digits: boolean;
  symbols: boolean;
};

/** Returns the selected character sets (each a list of unique characters), ambiguous ones removed if asked. */
export function selectedCharsets(toggles: CharsetToggles, avoidAmbiguous: boolean): string[][] {
  const all: [boolean, string][] = [
    [toggles.lowercase, LOWERCASE],
    [toggles.uppercase, UPPERCASE],
    [toggles.digits, DIGITS],
    [toggles.symbols, SYMBOLS],
  ];
  return all
    .filter(([on]) => on)
    .map(([, chars]) => [...chars].filter((c) => !avoidAmbiguous || !AMBIGUOUS.includes(c)));
}
