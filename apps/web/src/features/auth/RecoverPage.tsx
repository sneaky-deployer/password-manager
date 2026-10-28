import {
  apiPaths,
  emailCodeSchema,
  emailSchema,
  emailStartResponseSchema,
  okResponseSchema,
  type RecoveryTwoFactor,
  recoveryCompleteResponseSchema,
  recoveryStartResponseSchema,
} from "@pm/shared";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Alert, Button, Field, Input } from "../../components/ui/index.ts";
import { cryptoClient, isCryptoError } from "../../crypto-worker/client.ts";
import { CRYPTO_ERROR } from "../../crypto-worker/protocol.ts";
import { api, isApiError } from "../../lib/api.ts";
import { describeError } from "../../lib/errors.ts";
import { AuthLayout } from "./AuthLayout.tsx";
import { useFinishLogin } from "./LoginPage.tsx";
import {
  EMPTY_NEW_PASSWORD,
  NewPasswordFields,
  type NewPasswordValue,
  validateNewPassword,
} from "./NewPasswordFields.tsx";
import { RecoveryKitScreen } from "./RecoveryKitScreen.tsx";
import { ResetAccountFlow } from "./ResetAccountFlow.tsx";

type Stage =
  | { name: "email" }
  | { name: "proof" }
  | { name: "password" }
  | { name: "kit-offer" }
  | { name: "kit"; phrase: string; material: { wrappedAkRec: string; recoveryAuthKey: string } }
  | { name: "reset" };

interface Recovery {
  email: string;
  emailCode: string;
  phrase: string;
  userId: string;
  wrappedAkRec: string;
  recoveryToken: string;
}

/** PLAN.md 10.5 A (recovery kit) and D (reset account, data lost). */
export function RecoverPage() {
  const navigate = useNavigate();
  const finishLogin = useFinishLogin();
  const [stage, setStage] = useState<Stage>({ name: "email" });
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Step 2 inputs
  const [emailCode, setEmailCode] = useState("");
  const [phrase, setPhrase] = useState("");
  const [twoFactorMethods, setTwoFactorMethods] = useState<RecoveryTwoFactor["method"][] | null>(
    null,
  );
  const [twoFactorMethod, setTwoFactorMethod] = useState<RecoveryTwoFactor["method"]>("totp");
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [recovery, setRecovery] = useState<Recovery | null>(null);

  // Step 3 inputs
  const [password, setPassword] = useState<NewPasswordValue>(EMPTY_NEW_PASSWORD);
  const [submitted, setSubmitted] = useState(false);

  function parseEmail(): string | null {
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      setEmailError("Enter a valid email address.");
      return null;
    }
    setEmailError(null);
    return parsed.data;
  }

  async function sendCode() {
    const address = parseEmail();
    if (!address) return;
    setPending(true);
    setError(null);
    try {
      await api.post(apiPaths.auth.emailStart, {
        body: { email: address, purpose: "recovery" },
        schema: emailStartResponseSchema,
      });
      setStage({ name: "proof" });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  async function verifyProof() {
    const address = parseEmail();
    if (!address) return;
    setError(null);
    const code = emailCodeSchema.safeParse(emailCode);
    if (!code.success) {
      setError("Enter the 6-digit code from the email.");
      return;
    }
    if (!phrase.trim()) {
      setError("Enter your 24-word recovery phrase.");
      return;
    }
    let twoFactor: RecoveryTwoFactor | undefined;
    if (twoFactorMethods) {
      if (!twoFactorCode.trim()) {
        setError("Enter your verification code.");
        return;
      }
      twoFactor =
        twoFactorMethod === "totp"
          ? { method: "totp", code: twoFactorCode.trim() }
          : { method: "backup_code", code: twoFactorCode.trim() };
    }
    setPending(true);
    try {
      const { recoveryAuthKey } = await cryptoClient.call("startRecovery", { phrase });
      const result = await api.post(apiPaths.auth.recoveryStart, {
        body: {
          email: address,
          emailCode: code.data,
          recoveryAuthKey,
          ...(twoFactor ? { twoFactor } : {}),
        },
        schema: recoveryStartResponseSchema,
      });
      setRecovery({ email: address, emailCode: code.data, phrase, ...result });
      setStage({ name: "password" });
    } catch (err) {
      if (isApiError(err, "two_factor_required")) {
        const methods = readMethods(err.details);
        setTwoFactorMethods(methods);
        setTwoFactorMethod(methods[0] ?? "totp");
        setError(
          "Two-step verification is on for this account. Enter a code from your authenticator app or a backup code.",
        );
      } else {
        setError(describeError(err));
      }
    } finally {
      setPending(false);
    }
  }

  async function setNewPassword() {
    if (!recovery) return;
    setSubmitted(true);
    setError(null);
    if (validateNewPassword(password, [recovery.email])) return;
    setPending(true);
    try {
      const { material } = await cryptoClient.call("completeRecovery", {
        phrase: recovery.phrase,
        userId: recovery.userId,
        wrappedAkRec: recovery.wrappedAkRec,
        newPassword: password.password,
      });
      const response = await api.post(apiPaths.auth.recoveryComplete, {
        body: { recoveryToken: recovery.recoveryToken, ...material },
        schema: recoveryCompleteResponseSchema,
      });
      await finishLogin(response, { redirect: false });
      setPassword(EMPTY_NEW_PASSWORD);
      setPhrase("");
      setRecovery(null);
      setStage({ name: "kit-offer" });
    } catch (err) {
      await cryptoClient.call("lock").catch(() => undefined);
      if (isCryptoError(err, CRYPTO_ERROR.invalidRecoveryPhrase)) {
        setStage({ name: "proof" });
      }
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  async function prepareNewKit() {
    setPending(true);
    setError(null);
    try {
      const { recoveryPhrase, material } = await cryptoClient.call("buildRecoveryKit");
      setStage({ name: "kit", phrase: recoveryPhrase, material });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  if (stage.name === "reset") {
    return <ResetAccountFlow initialEmail={email} onCancel={() => setStage({ name: "email" })} />;
  }

  if (stage.name === "kit") {
    const { phrase: newPhrase, material } = stage;
    return (
      <AuthLayout
        wide
        title="Save your new recovery kit"
        subtitle="The old kit stops working once you confirm this one."
      >
        <RecoveryKitScreen
          phrase={newPhrase}
          email={email}
          confirmLabel="I saved it, open my vault"
          onConfirmed={async () => {
            await api.post(apiPaths.me.recovery, { body: material, schema: okResponseSchema });
            await navigate({ to: "/" });
          }}
          onSkip={() => void navigate({ to: "/" })}
        />
      </AuthLayout>
    );
  }

  if (stage.name === "kit-offer") {
    return (
      <AuthLayout title="Password changed" subtitle="You are signed in.">
        <Alert variant="info" title="Create a new recovery kit">
          You just used your recovery kit. Create a fresh one so the next recovery does not rely on
          a phrase that has already been typed in. Your old kit keeps working until you do.
        </Alert>
        {error ? <Alert variant="error">{error}</Alert> : null}
        <Button fullWidth loading={pending} onClick={() => void prepareNewKit()}>
          Create a new recovery kit
        </Button>
        <Button variant="ghost" fullWidth onClick={() => void navigate({ to: "/" })}>
          Skip for now
        </Button>
      </AuthLayout>
    );
  }

  if (stage.name === "password") {
    return (
      <AuthLayout
        title="Choose a new master password"
        subtitle="Your recovery phrase worked. Your data is intact."
      >
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void setNewPassword();
          }}
        >
          <NewPasswordFields
            value={password}
            onChange={setPassword}
            userInputs={recovery ? [recovery.email] : []}
            showErrors={submitted}
            disabled={pending}
          />
          {error ? <Alert variant="error">{error}</Alert> : null}
          <Button type="submit" fullWidth loading={pending}>
            {pending ? "Securing your account…" : "Set password and sign in"}
          </Button>
        </form>
      </AuthLayout>
    );
  }

  if (stage.name === "proof") {
    return (
      <AuthLayout
        title="Verify it is you"
        subtitle={`We emailed a 6-digit code to ${email.trim() || "your address"} if an account exists.`}
      >
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void verifyProof();
          }}
        >
          <Field label="Email code">
            {(control) => (
              <Input
                {...control}
                value={emailCode}
                inputMode="numeric"
                maxLength={6}
                autoComplete="one-time-code"
                onChange={(event) => setEmailCode(event.target.value)}
              />
            )}
          </Field>
          <Field
            label="Recovery phrase"
            hint="The 24 words from your recovery kit, separated by spaces."
          >
            {(control) => (
              <textarea
                {...control}
                value={phrase}
                rows={4}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) => setPhrase(event.target.value)}
                className="block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm focus:border-brand-600 focus:outline-2 focus:outline-brand-600/30 dark:border-slate-600 dark:bg-slate-900"
              />
            )}
          </Field>
          {twoFactorMethods ? (
            <fieldset className="space-y-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
              <legend className="px-1 text-sm font-medium">Two-step verification</legend>
              {twoFactorMethods.length > 1 ? (
                <div className="flex gap-4 text-sm">
                  {twoFactorMethods.map((m) => (
                    <label key={m} className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="two-factor-method"
                        checked={twoFactorMethod === m}
                        onChange={() => setTwoFactorMethod(m)}
                        className="accent-brand-600"
                      />
                      {m === "totp" ? "Authenticator app" : "Backup code"}
                    </label>
                  ))}
                </div>
              ) : null}
              <Field
                label={twoFactorMethod === "totp" ? "6-digit code" : "Backup code"}
                hint="If you only use passkeys, use one of your backup codes."
              >
                {(control) => (
                  <Input
                    {...control}
                    value={twoFactorCode}
                    autoComplete="one-time-code"
                    onChange={(event) => setTwoFactorCode(event.target.value)}
                  />
                )}
              </Field>
            </fieldset>
          ) : null}
          {error ? <Alert variant="error">{error}</Alert> : null}
          <Button type="submit" fullWidth loading={pending}>
            Continue
          </Button>
        </form>
        <div className="flex justify-between text-sm">
          <button
            type="button"
            className="text-brand-700 hover:underline dark:text-brand-300"
            onClick={() => void sendCode()}
          >
            Send the code again
          </button>
          <button
            type="button"
            className="text-brand-700 hover:underline dark:text-brand-300"
            onClick={() => setStage({ name: "reset" })}
          >
            I lost my recovery kit
          </button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Forgot your password?"
      subtitle="You can recover your account with the 24-word recovery kit you saved when you created it."
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void sendCode();
        }}
      >
        <Field label="Email" error={emailError}>
          {(control) => (
            <Input
              {...control}
              type="email"
              autoComplete="username"
              inputMode="email"
              autoCapitalize="none"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          )}
        </Field>
        {error ? <Alert variant="error">{error}</Alert> : null}
        <Button type="submit" fullWidth loading={pending}>
          Email me a code
        </Button>
      </form>
      <div className="space-y-2 border-t border-slate-200 pt-4 text-sm dark:border-slate-800">
        <p className="text-slate-600 dark:text-slate-400">
          No recovery kit? Nobody can recover your items without it. The last resort is to reset
          your account, which permanently deletes all your data.
        </p>
        <button
          type="button"
          className="font-medium text-red-700 hover:underline dark:text-red-400"
          onClick={() => setStage({ name: "reset" })}
        >
          Reset account (deletes all data)…
        </button>
      </div>
      <p className="text-center text-sm">
        <Link to="/login" className="text-brand-700 hover:underline dark:text-brand-300">
          Back to sign in
        </Link>
      </p>
    </AuthLayout>
  );
}

function readMethods(details: unknown): RecoveryTwoFactor["method"][] {
  const raw =
    typeof details === "object" && details !== null && "methods" in details
      ? (details as { methods: unknown }).methods
      : [];
  const methods = Array.isArray(raw)
    ? raw.filter((m): m is RecoveryTwoFactor["method"] => m === "totp" || m === "backup_code")
    : [];
  // Passkey-only accounts can still use a backup code.
  return methods.length > 0 ? methods : ["totp", "backup_code"];
}
