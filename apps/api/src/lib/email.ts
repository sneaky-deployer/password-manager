import type { Env } from "../env.ts";
import { AppError } from "./errors.ts";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface OutboxMessage extends EmailMessage {
  from: string;
  sentAt: number;
}

/** Lowercased, trimmed. Emails are always stored and compared in this form. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Development and test only: nothing is ever sent, messages are captured here. Module state lives
// per isolate, so it also works in `wrangler dev` (read it from tests via getDevOutbox()).
const outbox: OutboxMessage[] = [];

export function getDevOutbox(): readonly OutboxMessage[] {
  return outbox;
}

export function clearDevOutbox(): void {
  outbox.length = 0;
}

/** First link, else first 4-10 digit code, from a message body (for the dev console line). */
function firstLinkOrCode(text: string): string {
  const link = text.match(/https?:\/\/\S+/);
  if (link) return link[0];
  const code = text.match(/\b\d{4,10}\b/);
  return code ? code[0] : "(no link or code)";
}

/**
 * Sends a plain email through the Resend HTTP API (one `fetch`). Outside production it never
 * touches the network: the message is pushed to the in-memory dev outbox and, in `development`,
 * one console line shows the subject and the first link or code. Never log message bodies.
 * Throws `AppError("internal_error", 502)` if Resend rejects the message.
 */
export async function sendEmail(
  env: Pick<Env, "ENVIRONMENT" | "EMAIL_FROM" | "RESEND_API_KEY">,
  message: EmailMessage,
): Promise<void> {
  if (env.ENVIRONMENT !== "production") {
    outbox.push({ ...message, from: env.EMAIL_FROM, sentAt: Date.now() });
    if (env.ENVIRONMENT === "development") {
      console.log(
        `[dev email] to=${message.to} subject="${message.subject}" ${firstLinkOrCode(message.text)}`,
      );
    }
    return;
  }

  if (!env.RESEND_API_KEY) {
    throw new AppError("server_misconfigured", 503);
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    }),
  });
  if (!response.ok) {
    // Status only: the response body and the message are not logged.
    console.error(`email send failed: resend responded ${response.status}`);
    throw new AppError("internal_error", 502, "The email could not be sent.");
  }
}
