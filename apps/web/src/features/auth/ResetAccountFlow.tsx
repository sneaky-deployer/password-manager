import {
  apiPaths,
  emailCodeSchema,
  emailSchema,
  emailStartResponseSchema,
  resetAccountResponseSchema,
} from "@pm/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Alert, Button, Field, Input } from "../../components/ui/index.ts";
import { cryptoClient } from "../../crypto-worker/client.ts";
import { api } from "../../lib/api.ts";
import { describeError } from "../../lib/errors.ts";
import { markUnlocked, setSessionUser } from "../../lib/session.ts";
import { AuthLayout } from "./AuthLayout.tsx";
import {
  EMPTY_NEW_PASSWORD,
  NewPasswordFields,
  type NewPasswordValue,
  validateNewPassword,
} from "./NewPasswordFields.tsx";
import { RecoveryKitScreen } from "./RecoveryKitScreen.tsx";

export const RESET_CONFIRMATION_PHRASE = "DELETE MY DATA";

interface Props {
  initialEmail: string;
  onCancel: () => void;
}

/** PLAN.md 10.5 D: last resort. New keys and an empty vault; every old item is gone for good. */
export function ResetAccountFlow({ initialEmail, onCancel }: Props) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<"email" | "form" | "kit">("email");
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [password, setPassword] = useState<NewPasswordValue>(EMPTY_NEW_PASSWORD);
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phrase, setPhrase] = useState<string | null>(null);

  const parsedEmail = emailSchema.safeParse(email);

  async function sendCode() {
    if (!parsedEmail.success) {
      setError("Enter a valid email address.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await api.post(apiPaths.auth.emailStart, {
        body: { email: parsedEmail.data, purpose: "reset_account" },
        schema: emailStartResponseSchema,
      });
      setStep("form");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  async function reset() {
    setSubmitted(true);
    setError(null);
    if (!parsedEmail.success) return;
    const emailCode = emailCodeSchema.safeParse(code);
    if (!emailCode.success) {
      setError("Enter the 6-digit code from the email.");
      return;
    }
    if (confirmation.trim() !== RESET_CONFIRMATION_PHRASE) {
      setError(`Type ${RESET_CONFIRMATION_PHRASE} to confirm.`);
      return;
    }
    if (validateNewPassword(password, [parsedEmail.data])) return;
    setPending(true);
    try {
      const { creation, recoveryPhrase } = await cryptoClient.call("createAccount", {
        password: password.password,
        vaultName: "Personal",
      });
      const { user } = await api.post(apiPaths.auth.resetAccount, {
        body: { email: parsedEmail.data, emailCode: emailCode.data, ...creation },
        schema: resetAccountResponseSchema,
      });
      await cryptoClient.call("commitAccountCreation");
      setPassword(EMPTY_NEW_PASSWORD);
      setSessionUser(queryClient, user);
      markUnlocked();
      setPhrase(recoveryPhrase);
      setStep("kit");
    } catch (err) {
      await cryptoClient.call("lock").catch(() => undefined);
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  if (step === "kit" && phrase) {
    return (
      <AuthLayout
        wide
        title="Save your recovery kit"
        subtitle="Your account was reset with new keys."
      >
        <RecoveryKitScreen
          phrase={phrase}
          email={email}
          confirmLabel="I saved it, open my vault"
          onConfirmed={() => {
            setPhrase(null);
            void navigate({ to: "/" });
          }}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Reset account"
      subtitle="Last resort when the recovery kit is lost. This cannot be undone."
    >
      <Alert variant="error" title="All your items will be permanently deleted">
        Items others shared with you will need to be re-shared. Two-step verification and passkeys
        are removed and every session is signed out. Only continue if you cannot find your recovery
        kit.
      </Alert>

      {step === "email" ? (
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void sendCode();
          }}
        >
          <Field label="Email">
            {(control) => (
              <Input
                {...control}
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            )}
          </Field>
          {error ? <Alert variant="error">{error}</Alert> : null}
          <Button type="submit" variant="danger" fullWidth loading={pending}>
            Email me a confirmation code
          </Button>
        </form>
      ) : (
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void reset();
          }}
        >
          <Field label="Email code">
            {(control) => (
              <Input
                {...control}
                value={code}
                inputMode="numeric"
                maxLength={6}
                autoComplete="one-time-code"
                disabled={pending}
                onChange={(event) => setCode(event.target.value)}
              />
            )}
          </Field>
          <NewPasswordFields
            value={password}
            onChange={setPassword}
            userInputs={parsedEmail.success ? [parsedEmail.data] : []}
            showErrors={submitted}
            disabled={pending}
            passwordLabel="New master password"
          />
          <Field label={`Type ${RESET_CONFIRMATION_PHRASE} to confirm`}>
            {(control) => (
              <Input
                {...control}
                value={confirmation}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                disabled={pending}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            )}
          </Field>
          {error ? <Alert variant="error">{error}</Alert> : null}
          <Button type="submit" variant="danger" fullWidth loading={pending}>
            {pending ? "Securing your account…" : "Delete my data and reset account"}
          </Button>
        </form>
      )}
      <Button variant="ghost" fullWidth disabled={pending} onClick={onCancel}>
        Cancel
      </Button>
    </AuthLayout>
  );
}
