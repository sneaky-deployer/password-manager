import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearDevOutbox, getDevOutbox, sendEmail } from "../src/lib/email.ts";
import {
  adminSetupEmail,
  emailCodeEmail,
  inviteEmail,
  securityNoticeEmail,
} from "../src/lib/email-templates.ts";

describe("sendEmail", () => {
  beforeEach(clearDevOutbox);
  afterEach(() => vi.restoreAllMocks());

  it("captures the message in the dev outbox and never calls fetch (test env)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await sendEmail(env, {
      to: "a@example.test",
      subject: "Hello",
      text: "Open https://pm.test/invite#t=abc now",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getDevOutbox()).toHaveLength(1);
    expect(getDevOutbox()[0]).toMatchObject({
      to: "a@example.test",
      subject: "Hello",
      from: env.EMAIL_FROM,
    });
    clearDevOutbox();
    expect(getDevOutbox()).toHaveLength(0);
  });

  it("in development logs one line with the subject and the first link, and does not fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await sendEmail(
      { ...env, ENVIRONMENT: "development" },
      {
        to: "a@example.test",
        subject: "Invite",
        text: "Link: https://localhost:5173/invite#t=tok and https://other.example",
      },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(line).toContain("Invite");
    expect(line).toContain("https://localhost:5173/invite#t=tok");
    expect(line).not.toContain("other.example");
    expect(getDevOutbox()).toHaveLength(1);
  });

  it("in development logs the first code when there is no link", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await sendEmail(
      { ...env, ENVIRONMENT: "development" },
      { to: "a@example.test", subject: "Code", text: "Your code: 482913\nIt expires soon." },
    );
    expect(String(log.mock.calls[0]?.[0])).toContain("482913");
  });

  it("in production posts to the Resend API with the bearer key", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response('{"id":"1"}', { status: 200 }));
    await sendEmail(
      { ...env, ENVIRONMENT: "production", RESEND_API_KEY: "re_test_key" },
      { to: "a@example.test", subject: "S", text: "T" },
    );
    expect(getDevOutbox()).toHaveLength(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_test_key");
    expect(JSON.parse(String(init.body))).toEqual({
      from: env.EMAIL_FROM,
      to: ["a@example.test"],
      subject: "S",
      text: "T",
    });
  });

  it("in production throws a generic 502 when Resend rejects the message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 422 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      sendEmail(
        { ...env, ENVIRONMENT: "production", RESEND_API_KEY: "re_x" },
        { to: "a@example.test", subject: "S", text: "T" },
      ),
    ).rejects.toMatchObject({ code: "internal_error", status: 502 });
  });
});

describe("templates", () => {
  it("invite email carries the link, inviter and expiry, and is plain text", () => {
    const mail = inviteEmail({
      inviterEmail: "admin@example.test",
      link: "https://pm.test/invite#t=abc",
      expiresHours: 72,
      kind: "new_account",
    });
    expect(mail.subject).toBe("admin@example.test invited you to Password Manager");
    expect(mail.text).toContain("https://pm.test/invite#t=abc");
    expect(mail.text).toContain("72 hours");
    expect(mail.text).not.toMatch(/<[a-z]+/i);
  });

  it("account reset invite warns that data was deleted", () => {
    const mail = inviteEmail({
      inviterEmail: "admin@example.test",
      link: "https://pm.test/invite#t=x",
      expiresHours: 72,
      kind: "account_reset",
    });
    expect(mail.text).toContain("deleted");
    expect(mail.text).toContain("https://pm.test/invite#t=x");
  });

  it("admin setup, code and notice emails", () => {
    expect(adminSetupEmail({ link: "https://pm.test/invite#t=y" }).text).toContain(
      "https://pm.test/invite#t=y",
    );
    const code = emailCodeEmail({ code: "123456", purpose: "recovery" });
    expect(code.text).toContain("123456");
    expect(emailCodeEmail({ code: "123456", purpose: "reset_account" }).text).toContain(
      "permanently deletes",
    );
    expect(securityNoticeEmail({ event: "password_changed" }).text).toContain(
      "master password was changed",
    );
    expect(securityNoticeEmail({ event: "something_new" }).text).toContain("security-relevant");
    for (const mail of [code, securityNoticeEmail({ event: "recovery_used" })]) {
      expect(mail.text).not.toMatch(/https?:\/\/\S+\.(png|gif|jpg)/);
      expect(mail.text).not.toContain("<img");
    }
  });
});
