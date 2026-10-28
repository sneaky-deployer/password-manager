import { parseOtpInput, toOtpauthUri } from "@pm/otp";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Field, Input } from "../../components/ui/index.ts";
import { describeOtpError } from "./otp-errors.ts";
import { QrScannerDialog } from "./QrScannerDialog.tsx";
import { TotpRing } from "./TotpRing.tsx";
import { useTotp } from "./useTotp.ts";

export interface TotpInputProps {
  /**
   * Current value: "" (no TOTP), a normalised `otpauth://` URI, or text that is still invalid.
   */
  value: string;
  /**
   * Called on every edit with "" (empty), the normalised `otpauth://totp/...` URI once the input
   * parses, or the raw text while it does not. Validate with `parseOtpInput` before saving.
   */
  onChange: (uri: string) => void;
  /** External error (e.g. from form validation); shown instead of the parse message. */
  error?: string | undefined;
  /** Field label. Defaults to "Authenticator key". */
  label?: string;
}

/**
 * Editor field for a TOTP source: paste an `otpauth://` URI or a Base32 secret, or scan a QR code.
 * Valid input is normalised to a full URI (immediately in `onChange`, and in the box on blur) and
 * previews the live code; invalid input explains the problem in plain language.
 */
export function TotpInput({ value, onChange, error, label = "Authenticator key" }: TotpInputProps) {
  const [text, setText] = useState(value);
  const [touched, setTouched] = useState(false);
  const [scanning, setScanning] = useState(false);
  const lastEmitted = useRef(value);

  // Follow outside changes (e.g. the form was reset), but not the echo of our own onChange.
  useEffect(() => {
    if (value !== lastEmitted.current) {
      lastEmitted.current = value;
      setText(value);
    }
  }, [value]);

  const parsed = useMemo(() => parseOtpInput(text), [text]);
  const normalized = parsed.ok ? toOtpauthUri(parsed.config) : null;

  function emit(next: string) {
    lastEmitted.current = next;
    onChange(next);
  }

  function edit(next: string) {
    setText(next);
    const result = parseOtpInput(next);
    if (result.ok) emit(toOtpauthUri(result.config));
    else emit(result.error === "empty" ? "" : next);
  }

  function applyScanned(scanned: string) {
    const result = parseOtpInput(scanned);
    setTouched(true);
    setText(result.ok ? toOtpauthUri(result.config) : scanned);
    emit(result.ok ? toOtpauthUri(result.config) : scanned);
  }

  const parseMessage =
    touched && !parsed.ok && parsed.error !== "empty" ? describeOtpError(parsed.error) : undefined;

  return (
    <div className="space-y-2">
      <Field
        label={label}
        error={error ?? parseMessage}
        hint="Paste the setup key or the otpauth:// link from the service, or scan its QR code."
      >
        {(control) => (
          <div className="flex gap-2">
            <Input
              {...control}
              value={text}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="otpauth://totp/… or JBSWY3DPEHPK3PXP"
              className="min-w-0 flex-1 font-mono"
              onChange={(event) => edit(event.target.value)}
              onPaste={() => setTouched(true)}
              onBlur={() => {
                setTouched(true);
                if (normalized !== null) setText(normalized);
              }}
            />
            <Button variant="secondary" onClick={() => setScanning(true)}>
              Scan QR code
            </Button>
          </div>
        )}
      </Field>
      {normalized !== null ? <TotpPreview uri={normalized} /> : null}
      <QrScannerDialog open={scanning} onClose={() => setScanning(false)} onResult={applyScanned} />
    </div>
  );
}

function TotpPreview({ uri }: { uri: string }) {
  const totp = useTotp(uri);
  if (totp.status !== "ok") return null;
  const account = [totp.issuer, totp.label].filter(Boolean).join(" · ");
  return (
    <div className="space-y-2" data-testid="totp-preview">
      <div className="flex items-center gap-3 rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/60">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-slate-600 dark:text-slate-400">
            Current code{account ? ` for ${account}` : ""}
          </p>
          <p className="font-mono text-lg font-semibold tabular-nums tracking-wider">
            {totp.formatted}
          </p>
        </div>
        <TotpRing progress={totp.progress} expiring={totp.expiringSoon} className="size-6" />
      </div>
      {totp.weakSecret ? (
        <Alert variant="warning">
          This secret is shorter than the recommended 128 bits. It still works, but is less secure.
        </Alert>
      ) : null}
    </div>
  );
}
