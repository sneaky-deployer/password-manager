// Plain-text-first email templates (PLAN.md sections 10 and 16). No tracking pixels, no images,
// no remote content. Each function returns `{ subject, text }`; pass it to `sendEmail` with `to`.

export interface EmailContent {
  subject: string;
  text: string;
}

const SIGN_OFF = "Password Manager";

export function inviteEmail(input: {
  inviterEmail: string;
  link: string;
  expiresHours: number;
  kind: "new_account" | "account_reset";
}): EmailContent {
  const { inviterEmail, link, expiresHours, kind } = input;
  if (kind === "account_reset") {
    return {
      subject: "Set a new master password for Password Manager",
      text: [
        `${inviterEmail} reset your Password Manager account.`,
        "",
        "Your stored items were deleted. Open this link to choose a new master password:",
        link,
        "",
        `The link works once and expires in ${expiresHours} hours.`,
        "Nobody, including the administrator, can recover a master password later.",
        "If you did not expect this email, ignore it.",
        "",
        SIGN_OFF,
      ].join("\n"),
    };
  }
  return {
    subject: `${inviterEmail} invited you to Password Manager`,
    text: [
      `${inviterEmail} invited you to Password Manager.`,
      "",
      "Open this link to create your account and choose a master password:",
      link,
      "",
      `The link works once and expires in ${expiresHours} hours.`,
      "If you did not expect this email, ignore it.",
      "",
      SIGN_OFF,
    ].join("\n"),
  };
}

export function adminSetupEmail(input: { link: string; expiresHours?: number }): EmailContent {
  const expiry = input.expiresHours ? `expires in ${input.expiresHours} hours` : "expires soon";
  return {
    subject: "Set up your Password Manager administrator account",
    text: [
      "Someone asked to set up the administrator account of this Password Manager.",
      "",
      "Open this link to create the account and choose your master password:",
      input.link,
      "",
      `The link works once and ${expiry}.`,
      "If you did not request this, ignore this email.",
      "",
      SIGN_OFF,
    ].join("\n"),
  };
}

export type EmailCodePurposeLabel = "recovery" | "reset_account" | "sensitive_action";

const CODE_PURPOSES: Record<EmailCodePurposeLabel, { subject: string; reason: string }> = {
  recovery: {
    subject: "Your Password Manager recovery code",
    reason: "recover access to your account",
  },
  reset_account: {
    subject: "Your Password Manager account reset code",
    reason: "reset your account. This permanently deletes all your items",
  },
  sensitive_action: {
    subject: "Your Password Manager confirmation code",
    reason: "confirm a sensitive change to your account",
  },
};

export function emailCodeEmail(input: {
  code: string;
  purpose: EmailCodePurposeLabel;
  expiresMinutes?: number;
}): EmailContent {
  const { subject, reason } = CODE_PURPOSES[input.purpose];
  return {
    subject,
    text: [
      `Use this code to ${reason}:`,
      "",
      input.code,
      "",
      `It expires in ${input.expiresMinutes ?? 10} minutes and works once.`,
      "If you did not ask for it, someone may know your email address. You can ignore this message.",
      "",
      SIGN_OFF,
    ].join("\n"),
  };
}

const SECURITY_EVENTS: Record<string, string> = {
  password_changed: "Your master password was changed.",
  recovery_used: "Your password was reset with your recovery kit.",
  recovery_kit_regenerated: "Your recovery kit was replaced.",
  two_factor_enabled: "Two-factor authentication was turned on.",
  two_factor_disabled: "Two-factor authentication was turned off.",
  account_reset: "Your account was reset and its items were deleted.",
  new_sign_in: "A new device signed in to your account.",
};

export function securityNoticeEmail(input: { event: string }): EmailContent {
  const what =
    SECURITY_EVENTS[input.event] ?? "A security-relevant change was made to your account.";
  return {
    subject: "Security notice for your Password Manager account",
    text: [
      what,
      "",
      "If this was you, nothing else is needed.",
      "If it was not, sign in, change your master password and review Settings > Activity.",
      "",
      SIGN_OFF,
    ].join("\n"),
  };
}
