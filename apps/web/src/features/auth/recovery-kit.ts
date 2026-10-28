/** Helpers for the recovery kit screen (PLAN.md 10.1 step 6). Pure and UI-free. */

export const CONFIRM_WORD_COUNT = 3;

/** Unbiased random integer in [0, max) from the CSPRNG (rejection sampling). */
function randomBelow(max: number): number {
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    const value = buffer[0] as number;
    if (value < limit) return value % max;
  }
}

/** `count` distinct word positions (0-based) in ascending order. */
export function pickConfirmationIndexes(wordCount: number, count = CONFIRM_WORD_COUNT): number[] {
  const chosen = new Set<number>();
  while (chosen.size < Math.min(count, wordCount)) chosen.add(randomBelow(wordCount));
  return [...chosen].sort((a, b) => a - b);
}

export function splitPhrase(phrase: string): string[] {
  return phrase.trim().split(/\s+/);
}

export function wordsMatch(typed: string, expected: string): boolean {
  return typed.trim().toLowerCase() === expected.toLowerCase();
}

export function buildRecoveryKitText(params: {
  words: string[];
  email: string;
  date: Date;
}): string {
  const { words, email, date } = params;
  const numbered = words.map((word, i) => `${String(i + 1).padStart(2, " ")}. ${word}`).join("\n");
  return [
    "PASSWORD MANAGER RECOVERY KIT",
    "=============================",
    "",
    `Account: ${email}`,
    `Created: ${date.toISOString().slice(0, 10)}`,
    "",
    "Your 24 recovery words, in order:",
    "",
    numbered,
    "",
    "How to use this kit",
    '- If you forget your master password, choose "Forgot password" on the sign-in page.',
    "  You will need access to your email and these 24 words.",
    "- Without this kit, a forgotten master password means your data cannot be recovered.",
    "  Nobody, including the administrator, can reset it for you.",
    "",
    "Keep it safe",
    "- Print it or store it somewhere offline. Do not keep it in this password manager.",
    "- Anyone with these words and access to your email can open your vault.",
    "- Creating a new recovery kit makes this one stop working.",
    "",
  ].join("\n");
}

/** Trigger a browser download of a text file. */
export function downloadTextFile(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
