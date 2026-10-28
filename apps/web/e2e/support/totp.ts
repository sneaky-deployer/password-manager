import { expect } from "@playwright/test";
import { generateTotp } from "@pm/otp";

// RFC 6238 test secret ("12345678901234567890"), SHA1, 6 digits, 30 s.
export const TOTP_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const OTP = { secret: TOTP_SECRET, algorithm: "SHA1", digits: 6, period: 30 } as const;

/** The six digits shown in the detail pane must be a valid code for the time of the read. */
export async function expectShownCodeIsCurrent(
  read: () => Promise<string | null>,
): Promise<string> {
  // A period can roll over between computing and reading: accept the code from either side.
  const before = generateTotp(OTP);
  const shown = ((await read()) ?? "").replace(/\s/g, "");
  const after = generateTotp(OTP);
  expect(shown).toMatch(/^\d{6}$/);
  expect([before, after]).toContain(shown);
  return shown;
}
