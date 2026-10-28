import {
  apiPaths,
  changePasswordResponseSchema,
  emailCodeSchema,
  meEmailCodeResponseSchema,
  meKeysResponseSchema,
  resetFromUnlockedResponseSchema,
} from "@pm/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, Button, Card, Field, Input, PasswordInput } from "../../components/ui/index.ts";
import { cryptoClient, isCryptoError } from "../../crypto-worker/client.ts";
import { CRYPTO_ERROR } from "../../crypto-worker/protocol.ts";
import { api } from "../../lib/api.ts";
import { describeError } from "../../lib/errors.ts";
import { useRequiredUser } from "../../lib/session.ts";
import {
  EMPTY_NEW_PASSWORD,
  NewPasswordFields,
  type NewPasswordValue,
  validateNewPassword,
} from "../auth/NewPasswordFields.tsx";

/** PLAN.md 10.4 (knows the current password) and 10.5 B (unlocked device, email code instead). */
export function ChangePasswordCard() {
  const user = useRequiredUser();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"known" | "forgot">("known");
  const [current, setCurrent] = useState("");
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [password, setPassword] = useState<NewPasswordValue>(EMPTY_NEW_PASSWORD);
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function reset() {
    setCurrent("");
    setPassword(EMPTY_NEW_PASSWORD);
    setCode("");
    setCodeSent(false);
    setSubmitted(false);
  }

  async function sendCode() {
    setPending(true);
    setError(null);
    try {
      await api.post(apiPaths.me.emailCode, { schema: meEmailCodeResponseSchema });
      setCodeSent(true);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  async function submit() {
    setSubmitted(true);
    setError(null);
    setCurrentError(null);
    setDone(false);
    if (mode === "known" && !current) {
      setCurrentError("Enter your current password.");
      return;
    }
    if (validateNewPassword(password, [user.email])) return;
    let emailCode: string | undefined;
    if (mode === "forgot") {
      const parsed = emailCodeSchema.safeParse(code);
      if (!parsed.success) {
        setError("Enter the 6-digit code from the email.");
        return;
      }
      emailCode = parsed.data;
    }
    setPending(true);
    try {
      if (mode === "known") {
        const keyBundle = await api.get(apiPaths.me.keys, { schema: meKeysResponseSchema });
        const { currentAuthKey, material } = await cryptoClient.call("buildPasswordChange", {
          currentPassword: current,
          newPassword: password.password,
          keyBundle,
        });
        await api.post(apiPaths.me.password, {
          body: { currentAuthKey, ...material },
          schema: changePasswordResponseSchema,
        });
      } else {
        const { material } = await cryptoClient.call("buildPasswordReset", {
          newPassword: password.password,
        });
        await api.post(apiPaths.me.passwordResetFromUnlocked, {
          body: { emailCode, ...material },
          schema: resetFromUnlockedResponseSchema,
        });
      }
      reset();
      setDone(true);
      void queryClient.invalidateQueries({ queryKey: ["settings", "sessions"] });
    } catch (err) {
      if (isCryptoError(err, CRYPTO_ERROR.wrongPassword)) {
        setCurrentError("That is not your current password.");
      } else {
        setError(describeError(err));
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Card
      title="Master password"
      description="Changing it is instant: your items are not re-encrypted, and your recovery kit keeps working. Other devices are signed out."
    >
      {done ? (
        <Alert variant="success">Master password changed. Other devices were signed out.</Alert>
      ) : null}
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {mode === "known" ? (
          <Field label="Current password" error={currentError}>
            {(control) => (
              <PasswordInput
                {...control}
                autoComplete="current-password"
                value={current}
                disabled={pending}
                onChange={(event) => setCurrent(event.target.value)}
              />
            )}
          </Field>
        ) : (
          <div className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <p className="text-sm text-slate-600 dark:text-slate-400">
              This device is unlocked, so you can set a new password with a code we email you.
            </p>
            {codeSent ? (
              <Field label="Email code">
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
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              loading={pending && !codeSent}
              onClick={() => void sendCode()}
            >
              {codeSent ? "Send the code again" : "Email me a code"}
            </Button>
          </div>
        )}
        <NewPasswordFields
          value={password}
          onChange={setPassword}
          userInputs={[user.email]}
          showErrors={submitted}
          disabled={pending}
          passwordLabel="New password"
        />
        {error ? <Alert variant="error">{error}</Alert> : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" loading={pending} disabled={mode === "forgot" && !codeSent}>
            Change password
          </Button>
          <button
            type="button"
            className="text-sm text-brand-700 hover:underline dark:text-brand-300"
            onClick={() => {
              reset();
              setError(null);
              setCurrentError(null);
              setMode(mode === "known" ? "forgot" : "known");
            }}
          >
            {mode === "known"
              ? "I don't remember my current password"
              : "I remember my current password"}
          </button>
        </div>
      </form>
    </Card>
  );
}
