import { readFileSync } from "node:fs";
import { E2E_LOG } from "./env.ts";

export interface DevEmail {
  to: string;
  subject: string;
  /** First link (https?://...) or first 4-10 digit code of the body, as logged by the API. */
  payload: string;
  index: number;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI escapes from wrangler output
const ANSI = /\u001b\[[0-9;]*m/g;
const LINE = /\[dev email\] to=(\S+) subject="(.*)" (\S.*)$/;

function readEmails(): DevEmail[] {
  let text = "";
  try {
    text = readFileSync(E2E_LOG, "utf8");
  } catch {
    return [];
  }
  const out: DevEmail[] = [];
  for (const raw of text.split("\n")) {
    const match = LINE.exec(raw.replace(ANSI, "").trim());
    if (match) {
      out.push({
        to: match[1] ?? "",
        subject: match[2] ?? "",
        payload: match[3] ?? "",
        index: out.length,
      });
    }
  }
  return out;
}

/** Number of dev emails logged so far. Take it right before the action that sends an email. */
export function emailMark(): number {
  return readEmails().length;
}

/**
 * Polls wrangler's log for the newest email to `to` whose subject matches, sent after `since`
 * (an `emailMark()`), and returns the logged link or code.
 */
export async function waitForEmail(
  to: string,
  subject: RegExp | string,
  options: { since?: number; timeoutMs?: number } = {},
): Promise<DevEmail> {
  const { since = 0, timeoutMs = 15_000 } = options;
  const wanted = to.toLowerCase();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = readEmails()
      .filter(
        (e) =>
          e.index >= since &&
          e.to.toLowerCase() === wanted &&
          (typeof subject === "string" ? e.subject.includes(subject) : subject.test(e.subject)),
      )
      .at(-1);
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(
        `No email to ${to} matching ${String(subject)} after #${since} within ${timeoutMs} ms`,
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}
