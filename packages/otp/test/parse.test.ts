import { describe, expect, it } from "vitest";
import {
  isWeakSecret,
  type OtpConfig,
  type OtpParseError,
  parseOtpInput,
  toOtpauthUri,
} from "../src/index.ts";

const SECRET = "JBSWY3DPEHPK3PXP";
const LONG_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // 20 bytes

function ok(input: string): OtpConfig {
  const r = parseOtpInput(input);
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.config;
}

function err(input: string): OtpParseError {
  const r = parseOtpInput(input);
  if (r.ok) throw new Error("expected error");
  return r.error;
}

describe("parseOtpInput: URIs", () => {
  it("parses a Google Authenticator style URI", () => {
    expect(ok(`otpauth://totp/Example:alice@example.com?secret=${SECRET}&issuer=Example`)).toEqual({
      secret: SECRET,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      issuer: "Example",
      label: "alice@example.com",
    });
  });

  it("parses a GitHub style URI with encoded label", () => {
    const c = ok(
      `otpauth://totp/GitHub:octo%20cat?secret=${LONG_SECRET}&issuer=GitHub&algorithm=SHA1&digits=6&period=30`,
    );
    expect(c.issuer).toBe("GitHub");
    expect(c.label).toBe("octo cat");
  });

  it("takes the issuer from the label prefix when there is no param", () => {
    const c = ok(`otpauth://totp/ACME%20Co:bob?secret=${SECRET}`);
    expect(c.issuer).toBe("ACME Co");
    expect(c.label).toBe("bob");
  });

  it("handles an encoded colon and spaces after it", () => {
    const c = ok(`otpauth://totp/ACME%3A%20bob?secret=${SECRET}`);
    expect(c.issuer).toBe("ACME");
    expect(c.label).toBe("bob");
  });

  it("prefers the issuer param over a different label prefix and keeps the label whole", () => {
    const c = ok(`otpauth://totp/Old:bob?secret=${SECRET}&issuer=New`);
    expect(c.issuer).toBe("New");
    expect(c.label).toBe("Old:bob");
  });

  it("works without issuer", () => {
    const c = ok(`otpauth://totp/bob?secret=${SECRET}`);
    expect(c.issuer).toBeUndefined();
    expect(c.label).toBe("bob");
  });

  it("works with an empty label", () => {
    const c = ok(`otpauth://totp/?secret=${SECRET}`);
    expect(c.label).toBeUndefined();
    expect(c.issuer).toBeUndefined();
  });

  it("is case-insensitive for scheme, type, params and values", () => {
    const c = ok(
      `OTPAUTH://TOTP/x?SECRET=${SECRET.toLowerCase()}&Algorithm=sha256&DIGITS=8&Period=60`,
    );
    expect(c).toMatchObject({ secret: SECRET, algorithm: "SHA256", digits: 8, period: 60 });
  });

  it("accepts SHA512, 7 digits and period boundaries", () => {
    expect(
      ok(`otpauth://totp/x?secret=${SECRET}&algorithm=SHA512&digits=7&period=1`),
    ).toMatchObject({
      algorithm: "SHA512",
      digits: 7,
      period: 1,
    });
    expect(ok(`otpauth://totp/x?secret=${SECRET}&period=300`).period).toBe(300);
  });

  it("normalises spaced, lowercase, padded secrets in URIs", () => {
    expect(ok(`otpauth://totp/x?secret=jbsw%20y3dp-ehpk%203pxp%3D%3D`).secret).toBe(SECRET);
  });

  it("trims surrounding whitespace", () => {
    expect(ok(`  otpauth://totp/x?secret=${SECRET}\n`).secret).toBe(SECRET);
  });
});

describe("parseOtpInput: bare secrets", () => {
  it("applies defaults", () => {
    expect(ok(SECRET)).toEqual({ secret: SECRET, algorithm: "SHA1", digits: 6, period: 30 });
  });

  it("accepts lowercase, spaces, hyphens and padding", () => {
    expect(ok("jbsw y3dp ehpk 3pxp")).toMatchObject({ secret: SECRET });
    expect(ok("JBSW-Y3DP-EHPK-3PXP")).toMatchObject({ secret: SECRET });
    expect(ok("MFRGG===")).toMatchObject({ secret: "MFRGG" });
  });
});

describe("parseOtpInput: errors", () => {
  it("empty", () => {
    expect(err("")).toBe("empty");
    expect(err("  \n\t ")).toBe("empty");
  });

  it("invalid_uri", () => {
    expect(err("https://example.com/?secret=JBSWY3DP")).toBe("invalid_uri");
    expect(err("otpauth://steam/x?secret=JBSWY3DP")).toBe("invalid_uri");
    expect(err("otpauth://totp/%E0%A4%A?secret=JBSWY3DP")).toBe("invalid_uri");
    expect(err("otpauth://")).toBe("invalid_uri");
  });

  it("hotp_unsupported", () => {
    expect(err(`otpauth://hotp/x?secret=${SECRET}&counter=1`)).toBe("hotp_unsupported");
    expect(err(`OTPAUTH://HOTP/x?secret=${SECRET}`)).toBe("hotp_unsupported");
  });

  it("migration_unsupported", () => {
    expect(err("otpauth-migration://offline?data=CjEKCkhlbGxvId6tvu8")).toBe(
      "migration_unsupported",
    );
  });

  it("invalid_secret", () => {
    expect(err("not base32 !!!")).toBe("invalid_secret");
    expect(err("JBSWY3D1")).toBe("invalid_secret"); // '1' is not in the alphabet
    expect(err("A")).toBe("invalid_secret"); // less than one byte
    expect(err("otpauth://totp/x")).toBe("invalid_secret");
    expect(err("otpauth://totp/x?secret=")).toBe("invalid_secret");
    expect(err("otpauth://totp/x?secret=abc!")).toBe("invalid_secret");
  });

  it("invalid_digits", () => {
    for (const d of ["5", "9", "0", "abc", "", "6.5", "-6"]) {
      expect(err(`otpauth://totp/x?secret=${SECRET}&digits=${d}`)).toBe("invalid_digits");
    }
  });

  it("invalid_period", () => {
    for (const p of ["0", "301", "-30", "abc", "", "30.5"]) {
      expect(err(`otpauth://totp/x?secret=${SECRET}&period=${p}`)).toBe("invalid_period");
    }
  });

  it("invalid_algorithm", () => {
    for (const a of ["MD5", "SHA384", "", "SHA-1"]) {
      expect(err(`otpauth://totp/x?secret=${SECRET}&algorithm=${a}`)).toBe("invalid_algorithm");
    }
  });
});

describe("isWeakSecret", () => {
  it("is true below 16 bytes and false at or above", () => {
    expect(isWeakSecret(ok("MFRGG"))).toBe(true); // 3 bytes
    expect(isWeakSecret(ok(SECRET))).toBe(true); // 10 bytes
    expect(isWeakSecret(ok("A".repeat(25).replace(/A/g, "B")))).toBe(true); // 15 bytes
    expect(isWeakSecret(ok("B".repeat(26)))).toBe(false); // 16 bytes
    expect(isWeakSecret(ok(LONG_SECRET))).toBe(false);
  });

  it("weak secrets are still accepted by the parser", () => {
    expect(parseOtpInput("MFRGG").ok).toBe(true);
  });
});

describe("toOtpauthUri", () => {
  it("always includes algorithm, digits and period", () => {
    expect(toOtpauthUri({ secret: SECRET, algorithm: "SHA1", digits: 6, period: 30 })).toBe(
      `otpauth://totp/?secret=${SECRET}&algorithm=SHA1&digits=6&period=30`,
    );
  });

  it("encodes issuer and label", () => {
    expect(
      toOtpauthUri({
        secret: SECRET,
        algorithm: "SHA256",
        digits: 8,
        period: 60,
        issuer: "ACME Co",
        label: "bob@example.com",
      }),
    ).toBe(
      `otpauth://totp/ACME%20Co:bob%40example.com?secret=${SECRET}&issuer=ACME%20Co&algorithm=SHA256&digits=8&period=60`,
    );
  });

  const configs: OtpConfig[] = [
    { secret: SECRET, algorithm: "SHA1", digits: 6, period: 30 },
    {
      secret: LONG_SECRET,
      algorithm: "SHA512",
      digits: 8,
      period: 45,
      issuer: "A&B: Corp",
      label: "x y/z",
    },
    { secret: SECRET, algorithm: "SHA256", digits: 7, period: 1, label: "only-label" },
    { secret: SECRET, algorithm: "SHA1", digits: 6, period: 300, issuer: "Only Issuer" },
    { secret: SECRET, algorithm: "SHA1", digits: 6, period: 30, label: "a:b" },
    { secret: SECRET, algorithm: "SHA1", digits: 6, period: 30, issuer: "X: Y", label: "a:b" },
    {
      secret: SECRET,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      issuer: "Ünï",
      label: "名前@例.jp",
    },
  ];
  it.each(configs.map((c) => [c.issuer ?? c.label ?? "bare", c] as const))(
    "round-trips %s",
    (_name, config) => {
      const uri = toOtpauthUri(config);
      expect(ok(uri)).toEqual(config);
      expect(toOtpauthUri(ok(uri))).toBe(uri);
    },
  );
});
