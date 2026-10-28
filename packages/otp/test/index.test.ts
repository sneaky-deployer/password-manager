import { describe, expect, it } from "vitest";
import { OTPAuth, PACKAGE_NAME } from "../src/index.ts";

describe("@pm/otp", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@pm/otp");
  });

  it("generates RFC 6238 codes via otpauth", () => {
    // RFC 6238 appendix B, SHA1, T=59s, 8 digits.
    const totp = new OTPAuth.TOTP({
      secret: OTPAuth.Secret.fromUTF8("12345678901234567890"),
      digits: 8,
      period: 30,
    });
    expect(totp.generate({ timestamp: 59_000 })).toBe("94287082");
  });
});
