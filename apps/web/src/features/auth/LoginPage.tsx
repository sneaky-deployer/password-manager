import {
  apiPaths,
  emailSchema,
  kdfUpgradeResponseSchema,
  type LoginOkResponse,
  loginResponseSchema,
  preloginResponseSchema,
} from "@pm/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Alert, Button, Field, Input, PasswordInput } from "../../components/ui/index.ts";
import { cryptoClient } from "../../crypto-worker/client.ts";
import { api } from "../../lib/api.ts";
import { describeError } from "../../lib/errors.ts";
import { markUnlocked, setSessionUser } from "../../lib/session.ts";
import { AuthLayout } from "./AuthLayout.tsx";
import { type TwoFactorChallenge, TwoFactorStep } from "./TwoFactorStep.tsx";

/** Shared by login, 2FA and recovery: unlock the worker with the key bundle, then enter the app. */
export function useFinishLogin() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return async function finishLogin(
    response: LoginOkResponse,
    options: { redirect?: boolean } = {},
  ): Promise<void> {
    const { kdfUpgrade } = await cryptoClient.call("completeLogin", response.keys);
    markUnlocked();
    setSessionUser(queryClient, response.user);
    if (kdfUpgrade) {
      // PLAN 9.1: silently re-wrap with stronger KDF parameters. Never blocks sign-in.
      await api
        .post(apiPaths.me.kdfUpgrade, { body: kdfUpgrade, schema: kdfUpgradeResponseSchema })
        .catch(() => undefined);
    }
    if (options.redirect !== false) await navigate({ to: "/" });
  };
}

/** PLAN.md 10.2. Error messages are deliberately generic (no account enumeration). */
export function LoginPage() {
  const finishLogin = useFinishLogin();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<TwoFactorChallenge | null>(null);

  async function submit() {
    setError(null);
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      setEmailError("Enter a valid email address.");
      return;
    }
    setEmailError(null);
    if (!password) {
      setError("Enter your master password.");
      return;
    }
    setPending(true);
    try {
      const prelogin = await api.post(apiPaths.auth.prelogin, {
        body: { email: parsed.data },
        schema: preloginResponseSchema,
      });
      const { authKey } = await cryptoClient.call("login", {
        password,
        salt: prelogin.salt,
        kdf: prelogin.kdf,
      });
      setPassword("");
      const response = await api.post(apiPaths.auth.login, {
        body: { email: parsed.data, authKey },
        schema: loginResponseSchema,
      });
      if (response.status === "two_factor_required") {
        setChallenge({ challengeToken: response.challengeToken, methods: response.methods });
        setPending(false);
        return;
      }
      await finishLogin(response);
    } catch (err) {
      await cryptoClient.call("lock").catch(() => undefined);
      setError(describeError(err));
      setPending(false);
    }
  }

  if (challenge) {
    return (
      <AuthLayout title="Two-step verification" subtitle="Confirm it is you to finish signing in.">
        <TwoFactorStep
          challenge={challenge}
          onVerified={async (response) => {
            try {
              await finishLogin(response);
            } catch (err) {
              await cryptoClient.call("lock").catch(() => undefined);
              setChallenge(null);
              setPending(false);
              setError(describeError(err));
            }
          }}
          onBack={(message) => {
            void cryptoClient.call("lock").catch(() => undefined);
            setChallenge(null);
            setPending(false);
            setError(message ?? null);
          }}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Sign in" subtitle="Welcome back.">
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="Email" error={emailError}>
          {(control) => (
            <Input
              {...control}
              type="email"
              name="email"
              autoComplete="username"
              inputMode="email"
              autoCapitalize="none"
              value={email}
              disabled={pending}
              onChange={(event) => setEmail(event.target.value)}
            />
          )}
        </Field>
        <Field label="Master password">
          {(control) => (
            <PasswordInput
              {...control}
              name="password"
              autoComplete="current-password"
              value={password}
              disabled={pending}
              onChange={(event) => setPassword(event.target.value)}
            />
          )}
        </Field>
        {error ? <Alert variant="error">{error}</Alert> : null}
        <Button type="submit" fullWidth loading={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </Button>
        {pending ? (
          <p className="text-center text-xs text-slate-600 dark:text-slate-400" role="status">
            Deriving your keys. This takes a moment.
          </p>
        ) : null}
      </form>
      <p className="text-center text-sm">
        <Link to="/recover" className="text-brand-700 hover:underline dark:text-brand-300">
          Forgot password?
        </Link>
      </p>
    </AuthLayout>
  );
}
