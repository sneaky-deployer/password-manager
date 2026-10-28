import { Secret } from "otpauth";
import { describe, expect, it } from "vitest";
import {
  formatCode,
  generateTotp,
  generateTotpAt,
  isExpiringSoon,
  nextCode,
  type OtpAlgorithm,
  type OtpConfig,
  progress,
  secondsRemaining,
  timeStep,
} from "../src/index.ts";

const SEEDS: Record<OtpAlgorithm, string> = {
  SHA1: "12345678901234567890",
  SHA256: "12345678901234567890123456789012",
  SHA512: "1234567890123456789012345678901234567890123456789012345678901234",
};

function rfcConfig(algorithm: OtpAlgorithm): OtpConfig {
  return {
    secret: Secret.fromUTF8(SEEDS[algorithm]).base32,
    algorithm,
    digits: 8,
    period: 30,
  };
}

// RFC 6238 Appendix B: [time (s), SHA1, SHA256, SHA512]
const RFC6238: [number, string, string, string][] = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

describe("RFC 6238 Appendix B", () => {
  for (const [time, sha1, sha256, sha512] of RFC6238) {
    it(`T=${time}`, () => {
      expect(generateTotp(rfcConfig("SHA1"), time * 1000)).toBe(sha1);
      expect(generateTotp(rfcConfig("SHA256"), time * 1000)).toBe(sha256);
      expect(generateTotp(rfcConfig("SHA512"), time * 1000)).toBe(sha512);
    });
  }
});

describe("RFC 4226 HOTP vectors via generateTotpAt", () => {
  const expected = [
    "755224",
    "287082",
    "359152",
    "969429",
    "338314",
    "254676",
    "287922",
    "162583",
    "399871",
    "520489",
  ];
  const config: OtpConfig = {
    secret: Secret.fromUTF8(SEEDS.SHA1).base32,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
  };
  it.each(expected.map((code, counter) => [counter, code] as const))(
    "counter %i",
    (counter, code) => {
      expect(generateTotpAt(config, counter)).toBe(code);
    },
  );
});

describe("codes", () => {
  const config: OtpConfig = {
    secret: Secret.fromUTF8(SEEDS.SHA1).base32,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
  };

  it("zero-pads", () => {
    // RFC 6238 SHA1 at T=1111111109 with 8 digits starts with 0.
    expect(generateTotp({ ...rfcConfig("SHA1") }, 1111111109_000)).toBe("07081804");
  });

  it("nextCode is the code of the following period", () => {
    const t = 1_700_000_010_000;
    expect(nextCode(config, t)).toBe(generateTotp(config, t + 30_000));
    expect(nextCode(config, t)).not.toBe(generateTotp(config, t));
  });

  it("is stable within a period and changes on the boundary", () => {
    const start = 30_000 * 1000;
    expect(generateTotp(config, start)).toBe(generateTotp(config, start + 29_999));
    expect(generateTotp(config, start)).not.toBe(generateTotp(config, start + 30_000));
  });
});

describe("countdown maths", () => {
  it("timeStep", () => {
    expect(timeStep(30, 0)).toBe(0);
    expect(timeStep(30, 29_999)).toBe(0);
    expect(timeStep(30, 30_000)).toBe(1);
    expect(timeStep(60, 59_999)).toBe(0);
    expect(timeStep(60, 60_000)).toBe(1);
  });

  it("secondsRemaining is in 1..period at exact boundaries (period 30)", () => {
    expect(secondsRemaining(30, 0)).toBe(30);
    expect(secondsRemaining(30, 999)).toBe(30);
    expect(secondsRemaining(30, 1_000)).toBe(29);
    expect(secondsRemaining(30, 29_000)).toBe(1);
    expect(secondsRemaining(30, 29_999)).toBe(1);
    expect(secondsRemaining(30, 30_000)).toBe(30);
  });

  it("secondsRemaining (period 60)", () => {
    expect(secondsRemaining(60, 0)).toBe(60);
    expect(secondsRemaining(60, 59_999)).toBe(1);
    expect(secondsRemaining(60, 60_000)).toBe(60);
    expect(secondsRemaining(60, 90_500)).toBe(30);
  });

  it("never returns 0 across a whole period", () => {
    for (let ms = 0; ms < 120_000; ms += 250) {
      const r = secondsRemaining(30, ms);
      expect(r).toBeGreaterThanOrEqual(1);
      expect(r).toBeLessThanOrEqual(30);
    }
  });

  it("progress", () => {
    expect(progress(30, 0)).toBe(0);
    expect(progress(30, 15_000)).toBe(0.5);
    expect(progress(30, 29_999)).toBeCloseTo(29_999 / 30_000, 10);
    expect(progress(30, 30_000)).toBe(0);
    expect(progress(60, 45_000)).toBe(0.75);
    expect(progress(30, 1_700_000_007_500)).toBeCloseTo((1_700_000_007_500 % 30_000) / 30_000, 10);
  });

  it("isExpiringSoon", () => {
    expect(isExpiringSoon(30, 0)).toBe(false);
    expect(isExpiringSoon(30, 24_999)).toBe(false); // 6 s left
    expect(isExpiringSoon(30, 25_000)).toBe(true); // 5 s left
    expect(isExpiringSoon(30, 29_999)).toBe(true);
    expect(isExpiringSoon(30, 30_000)).toBe(false);
    expect(isExpiringSoon(30, 20_000, 10)).toBe(true);
    expect(isExpiringSoon(60, 54_999)).toBe(false);
    expect(isExpiringSoon(60, 55_000)).toBe(true);
  });
});

describe("formatCode", () => {
  it("groups by length", () => {
    expect(formatCode("123456")).toBe("123 456");
    expect(formatCode("1234567")).toBe("123 4567");
    expect(formatCode("12345678")).toBe("1234 5678");
  });
});
