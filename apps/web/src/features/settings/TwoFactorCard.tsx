import {
  apiPaths,
  type TotpSetupResponse,
  totpDisableResponseSchema,
  totpEnableResponseSchema,
  totpSetupResponseSchema,
} from "@pm/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  CopyButton,
  Dialog,
  Field,
  Input,
  QrCode,
} from "../../components/ui/index.ts";
import { api } from "../../lib/api.ts";
import { describeError } from "../../lib/errors.ts";
import { groupSecret } from "../../lib/format.ts";
import { refreshSession, useRequiredUser } from "../../lib/session.ts";
import { BackupCodesDialog } from "./BackupCodesDialog.tsx";

/** Login 2FA with an authenticator app (PLAN.md 10.6). */
export function TwoFactorCard() {
  const user = useRequiredUser();
  const queryClient = useQueryClient();
  const enabled = user.twoFactor.totp;
  const [setup, setSetup] = useState<TotpSetupResponse | null>(null);
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [disableMethod, setDisableMethod] = useState<"totp" | "backup_code">("totp");
  const [disableCode, setDisableCode] = useState("");
  const [disableError, setDisableError] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);

  async function startSetup() {
    setPending(true);
    setError(null);
    try {
      setSetup(await api.post(apiPaths.me.totpSetup, { schema: totpSetupResponseSchema }));
      setCode("");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  async function enable() {
    setPending(true);
    setError(null);
    try {
      const result = await api.post(apiPaths.me.totpEnable, {
        body: { code: code.trim() },
        schema: totpEnableResponseSchema,
      });
      setSetup(null);
      setCode("");
      if (result.backupCodes) setBackupCodes(result.backupCodes);
      await refreshSession(queryClient);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  async function disable() {
    const code = disableCode.trim();
    if (!code) {
      setDisableError("Enter a code to confirm it is you.");
      return;
    }
    setPending(true);
    setDisableError(null);
    try {
      // The server asks for proof of a second factor: a current TOTP code or a backup code.
      await api.post(apiPaths.me.totpDisable, {
        body: { method: disableMethod, code },
        schema: totpDisableResponseSchema,
      });
      setConfirmDisable(false);
      setDisableCode("");
      await refreshSession(queryClient);
    } catch (err) {
      setDisableError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card
      title="Authenticator app"
      description="Require a 6-digit code from an authenticator app when you sign in. This protects sign-in only; your data stays encrypted either way."
      actions={<Badge tone={enabled ? "success" : "neutral"}>{enabled ? "On" : "Off"}</Badge>}
    >
      {error ? <Alert variant="error">{error}</Alert> : null}

      {enabled ? (
        <Button variant="secondary" onClick={() => setConfirmDisable(true)}>
          Turn off
        </Button>
      ) : setup ? (
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void enable();
          }}
        >
          <ol className="list-decimal space-y-4 pl-5 text-sm">
            <li>
              Scan this QR code with your authenticator app.
              <div className="mt-2">
                <QrCode value={setup.otpauthUri} label="QR code for your authenticator app" />
              </div>
            </li>
            <li>
              Or enter the secret key by hand:
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code
                  className="rounded bg-slate-100 px-2 py-1 font-mono text-sm tracking-wide dark:bg-slate-800"
                  data-testid="totp-secret"
                >
                  {groupSecret(setup.secret)}
                </code>
                <CopyButton value={setup.secret} label="Copy secret" />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {setup.otpauthUri.startsWith("otpauth://") ? (
                  <a
                    href={setup.otpauthUri}
                    className="text-brand-700 underline dark:text-brand-300"
                  >
                    Open in authenticator app
                  </a>
                ) : null}
                <CopyButton value={setup.otpauthUri} label="Copy setup URI" />
              </div>
            </li>
            <li>
              Enter the 6-digit code the app shows to confirm.
              <div className="mt-2 max-w-48">
                <Field label="Verification code">
                  {(control) => (
                    <Input
                      {...control}
                      inputMode="numeric"
                      maxLength={6}
                      autoComplete="one-time-code"
                      value={code}
                      onChange={(event) => setCode(event.target.value)}
                    />
                  )}
                </Field>
              </div>
            </li>
          </ol>
          <div className="flex gap-2">
            <Button type="submit" loading={pending}>
              Turn on
            </Button>
            <Button variant="ghost" disabled={pending} onClick={() => setSetup(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button loading={pending} onClick={() => void startSetup()}>
          Set up authenticator app
        </Button>
      )}

      <Dialog
        open={confirmDisable}
        onClose={() => {
          setConfirmDisable(false);
          setDisableCode("");
          setDisableError(null);
        }}
        title="Turn off authenticator app?"
        description="Sign-in will rely on your password alone unless you also have passkeys. Enter a code to confirm it is you."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDisable(false)}>
              Cancel
            </Button>
            <Button variant="danger" loading={pending} onClick={() => void disable()}>
              Turn off
            </Button>
          </>
        }
      >
        <div className="flex gap-4 text-sm">
          {(["totp", "backup_code"] as const).map((method) => (
            <label key={method} className="flex items-center gap-2">
              <input
                type="radio"
                name="disable-method"
                checked={disableMethod === method}
                onChange={() => setDisableMethod(method)}
                className="accent-brand-600"
              />
              {method === "totp" ? "Authenticator code" : "Backup code"}
            </label>
          ))}
        </div>
        <Field
          label={disableMethod === "totp" ? "6-digit code" : "Backup code"}
          error={disableError}
        >
          {(control) => (
            <Input
              {...control}
              value={disableCode}
              autoComplete="one-time-code"
              {...(disableMethod === "totp" ? { inputMode: "numeric" as const, maxLength: 6 } : {})}
              onChange={(event) => setDisableCode(event.target.value)}
            />
          )}
        </Field>
      </Dialog>
      <BackupCodesDialog
        codes={backupCodes}
        email={user.email}
        onClose={() => setBackupCodes(null)}
      />
    </Card>
  );
}
