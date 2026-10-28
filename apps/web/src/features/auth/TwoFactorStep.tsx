import {
  apiPaths,
  type LoginOkResponse,
  type TwoFactorMethod,
  type TwoFactorVerifyRequest,
  twoFactorVerifyResponseSchema,
  webauthnOptionsResponseSchema,
} from "@pm/shared";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { useState } from "react";
import { Alert, Button, Field, Input } from "../../components/ui/index.ts";
import { api, isApiError } from "../../lib/api.ts";
import { cn } from "../../lib/cn.ts";
import { describeError } from "../../lib/errors.ts";

export interface TwoFactorChallenge {
  challengeToken: string;
  methods: TwoFactorMethod[];
}

interface Props {
  challenge: TwoFactorChallenge;
  onVerified: (response: LoginOkResponse) => Promise<void>;
  /** The challenge expired or the user wants to start over. */
  onBack: (message?: string) => void;
}

const METHOD_LABELS: Record<TwoFactorMethod, string> = {
  totp: "Authenticator app",
  webauthn: "Passkey",
  backup_code: "Backup code",
};

const METHOD_ORDER: TwoFactorMethod[] = ["totp", "webauthn", "backup_code"];

/** Step 2 of login (PLAN.md 10.2/10.6): TOTP, passkey or backup code. */
export function TwoFactorStep({ challenge, onVerified, onBack }: Props) {
  const methods = METHOD_ORDER.filter(
    (m) => challenge.methods.includes(m) && (m !== "webauthn" || browserSupportsWebAuthn()),
  );
  const [method, setMethod] = useState<TwoFactorMethod>(methods[0] ?? "backup_code");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function verify(body: TwoFactorVerifyRequest) {
    setPending(true);
    setError(null);
    try {
      const response = await api.post(apiPaths.auth.twoFactorVerify, {
        body,
        schema: twoFactorVerifyResponseSchema,
      });
      await onVerified(response);
    } catch (err) {
      if (isApiError(err, "challenge_invalid")) {
        onBack("Your sign-in attempt expired. Sign in again.");
        return;
      }
      setError(describeError(err));
      setPending(false);
    }
  }

  async function submitCode() {
    const value = code.trim();
    if (!value) {
      setError("Enter a code.");
      return;
    }
    if (method === "totp") {
      await verify({ challengeToken: challenge.challengeToken, method: "totp", code: value });
    } else {
      await verify({
        challengeToken: challenge.challengeToken,
        method: "backup_code",
        code: value,
      });
    }
  }

  async function signInWithPasskey() {
    setPending(true);
    setError(null);
    try {
      const { options } = await api.post(apiPaths.auth.webauthnOptions, {
        body: { challengeToken: challenge.challengeToken },
        schema: webauthnOptionsResponseSchema,
      });
      const assertion = await startAuthentication({
        optionsJSON: options as unknown as Parameters<typeof startAuthentication>[0]["optionsJSON"],
      });
      await verify({
        challengeToken: challenge.challengeToken,
        method: "webauthn",
        assertion: assertion as unknown as Extract<
          TwoFactorVerifyRequest,
          { method: "webauthn" }
        >["assertion"],
      });
    } catch (err) {
      if (isApiError(err, "challenge_invalid")) {
        onBack("Your sign-in attempt expired. Sign in again.");
        return;
      }
      setError(
        err instanceof Error && err.name === "NotAllowedError"
          ? "Passkey sign-in was cancelled or timed out."
          : describeError(err, "Passkey sign-in failed."),
      );
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      {methods.length > 1 ? (
        <div
          role="tablist"
          aria-label="Verification method"
          className="flex gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800"
        >
          {methods.map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={method === m}
              onClick={() => {
                setMethod(m);
                setCode("");
                setError(null);
              }}
              className={cn(
                "flex-1 rounded-md px-2 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-brand-600",
                method === m
                  ? "bg-white shadow-sm dark:bg-slate-900"
                  : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100",
              )}
            >
              {METHOD_LABELS[m]}
            </button>
          ))}
        </div>
      ) : null}

      {method === "webauthn" ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Use your passkey or security key to finish signing in.
          </p>
          {error ? <Alert variant="error">{error}</Alert> : null}
          <Button fullWidth loading={pending} onClick={() => void signInWithPasskey()}>
            Use passkey
          </Button>
        </div>
      ) : (
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submitCode();
          }}
        >
          <Field
            label={method === "totp" ? "6-digit code" : "Backup code"}
            hint={
              method === "totp" ? "From your authenticator app." : "Each backup code works once."
            }
          >
            {(control) => (
              <Input
                {...control}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                autoComplete="one-time-code"
                autoCapitalize="none"
                spellCheck={false}
                {...(method === "totp"
                  ? { inputMode: "numeric" as const, maxLength: 6, pattern: "[0-9]*" }
                  : {})}
              />
            )}
          </Field>
          {error ? <Alert variant="error">{error}</Alert> : null}
          <Button type="submit" fullWidth loading={pending}>
            Verify
          </Button>
        </form>
      )}

      <Button variant="ghost" fullWidth disabled={pending} onClick={() => onBack()}>
        Back to sign in
      </Button>
    </div>
  );
}
