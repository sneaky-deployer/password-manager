import { type OtpParseError, parseOtpInput, toOtpauthUri } from "@pm/otp";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { describeOtpError } from "./otp-errors.ts";
import { decodeImageBlob } from "./qr-decode.ts";
import { TotpInput } from "./TotpInput.tsx";

vi.mock("./qr-decode.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./qr-decode.ts")>();
  return { ...actual, decodeImageBlob: vi.fn() };
});

const SECRET = "JBSWY3DPEHPK3PXP";

function normalised(input: string): string {
  const parsed = parseOtpInput(input);
  if (!parsed.ok) throw new Error("fixture must parse");
  return toOtpauthUri(parsed.config);
}

function Harness({
  initial = "",
  onChange,
  error,
}: {
  initial?: string;
  onChange?: (v: string) => void;
  error?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <TotpInput
      value={value}
      error={error}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

const field = () => screen.getByLabelText("Authenticator key") as HTMLInputElement;

describe("TotpInput", () => {
  it("normalises a bare secret to a full otpauth URI", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(field());
    await user.paste(`${SECRET.toLowerCase().slice(0, 4)} ${SECRET.slice(4)}`);

    const expected = normalised(SECRET);
    expect(expected).toBe(`otpauth://totp/?secret=${SECRET}&algorithm=SHA1&digits=6&period=30`);
    expect(onChange).toHaveBeenLastCalledWith(expected);
    // The text box keeps what was typed until it loses focus...
    expect(field().value).toContain(" ");
    await user.tab();
    expect(field().value).toBe(expected);
  });

  it("shows a live preview of the current code", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByTestId("totp-preview")).not.toBeInTheDocument();
    await user.click(field());
    await user.paste(`otpauth://totp/GitHub:me?secret=${SECRET}&issuer=GitHub`);
    const preview = screen.getByTestId("totp-preview");
    expect(preview).toHaveTextContent("Current code for GitHub · me");
    expect(preview).toHaveTextContent(/\d{3} \d{3}/);
    expect(preview).toHaveTextContent("shorter than the recommended 128 bits");
  });

  it("emits an empty string when cleared and no error", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={normalised(SECRET)} onChange={onChange} />);
    expect(field().value).toBe(normalised(SECRET));
    await user.clear(field());
    await user.tab();
    expect(onChange).toHaveBeenLastCalledWith("");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  const cases: Array<[OtpParseError, string]> = [
    ["invalid_uri", "https://example.com/not-otp"],
    ["hotp_unsupported", `otpauth://hotp/x?secret=${SECRET}&counter=1`],
    ["invalid_secret", "this is not base32!"],
    ["invalid_digits", `otpauth://totp/x?secret=${SECRET}&digits=9`],
    ["invalid_period", `otpauth://totp/x?secret=${SECRET}&period=0`],
    ["invalid_algorithm", `otpauth://totp/x?secret=${SECRET}&algorithm=MD5`],
    ["migration_unsupported", "otpauth-migration://offline?data=abc"],
  ];

  it.each(cases)("explains %s in plain language", async (code, input) => {
    expect(parseOtpInput(input)).toEqual({ ok: false, error: code });
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(field());
    await user.paste(input);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(describeOtpError(code));
    expect(field()).toHaveAttribute("aria-invalid", "true");
    expect(onChange).toHaveBeenLastCalledWith(input);
    expect(screen.queryByTestId("totp-preview")).not.toBeInTheDocument();
  });

  it("has a distinct, non-empty message for every error code", () => {
    const codes: OtpParseError[] = [
      "empty",
      "invalid_uri",
      "hotp_unsupported",
      "invalid_secret",
      "invalid_digits",
      "invalid_period",
      "invalid_algorithm",
      "migration_unsupported",
    ];
    const messages = codes.map(describeOtpError);
    expect(new Set(messages).size).toBe(codes.length);
    for (const message of messages) expect(message.length).toBeGreaterThan(10);
    expect(describeOtpError("hotp_unsupported")).toMatch(/HOTP/);
    expect(describeOtpError("migration_unsupported")).toMatch(/Google Authenticator/);
  });

  it("does not nag while typing before the first blur", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(field(), "otpauth:");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.tab();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("shows an external error prop", () => {
    render(<Harness error="This item needs a code." />);
    expect(screen.getByRole("alert")).toHaveTextContent("This item needs a code.");
  });

  it("follows outside value changes", () => {
    const { rerender } = render(<TotpInput value="" onChange={() => {}} />);
    rerender(<TotpInput value={normalised(SECRET)} onChange={() => {}} />);
    expect(field().value).toBe(normalised(SECRET));
  });

  it("opens the QR scanner and applies a scanned URI", async () => {
    const scanned = `otpauth://totp/Example:me?secret=${SECRET}&issuer=Example`;
    vi.mocked(decodeImageBlob).mockResolvedValue(scanned);
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "Scan QR code" }));
    const dialog = screen.getByRole("dialog", { name: "Scan QR code" });
    await user.upload(
      within(dialog).getByLabelText("Upload an image"),
      new File(["x"], "qr.png", { type: "image/png" }),
    );
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(normalised(scanned)));
    expect(field().value).toBe(normalised(scanned));
    expect(screen.getByTestId("totp-preview")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
