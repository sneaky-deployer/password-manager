import { apiPaths, kdfUpgradeResponseSchema, meKeysResponseSchema } from "@pm/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Alert, Button, Field, PasswordInput } from "../../components/ui/index.ts";
import { cryptoClient, isCryptoError } from "../../crypto-worker/client.ts";
import { CRYPTO_ERROR } from "../../crypto-worker/protocol.ts";
import { api } from "../../lib/api.ts";
import { describeError, formatWait } from "../../lib/errors.ts";
import { logout, markUnlocked, useSession } from "../../lib/session.ts";
import { AuthLayout } from "./AuthLayout.tsx";
import { recordUnlockFailure, resetUnlockBackoff, unlockBlockedUntil } from "./unlock-backoff.ts";

/** Only same-app absolute paths may be used as a post-unlock destination. */
export function safeNextPath(next: string | undefined): string {
  if (!next?.startsWith("/") || next.startsWith("//")) return "/";
  if (/^\/(unlock|login|setup|invite|recover)(\/|$|\?)/.test(next)) return "/";
  return next;
}

/** PLAN.md 10.3: unlock with the master password; the check is local (no server call). */
export function UnlockPage({ next }: { next?: string | undefined }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useSession();
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockedUntil, setBlockedUntil] = useState(unlockBlockedUntil());
  const [now, setNow] = useState(Date.now());

  const waitMs = Math.max(0, blockedUntil - now);
  useEffect(() => {
    if (waitMs <= 0) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [waitMs]);

  async function submit() {
    if (waitMs > 0 || !password) return;
    setPending(true);
    setError(null);
    try {
      const keyBundle = await api.get(apiPaths.me.keys, { schema: meKeysResponseSchema });
      const { kdfUpgrade } = await cryptoClient.call("unlock", { password, keyBundle });
      resetUnlockBackoff();
      markUnlocked();
      setPassword("");
      if (kdfUpgrade) {
        await api
          .post(apiPaths.me.kdfUpgrade, { body: kdfUpgrade, schema: kdfUpgradeResponseSchema })
          .catch(() => undefined);
      }
      router.history.push(safeNextPath(next));
    } catch (err) {
      if (isCryptoError(err, CRYPTO_ERROR.wrongPassword)) {
        const until = recordUnlockFailure();
        setBlockedUntil(until);
        setNow(Date.now());
        setError("Wrong password.");
      } else {
        setError(describeError(err));
      }
      setPending(false);
    }
  }

  return (
    <AuthLayout
      title="Vault locked"
      subtitle={
        user ? `Enter your master password to unlock ${user.email}.` : "Enter your master password."
      }
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="Master password">
          {(control) => (
            <PasswordInput
              {...control}
              autoFocus
              name="password"
              autoComplete="current-password"
              value={password}
              disabled={pending}
              onChange={(event) => setPassword(event.target.value)}
            />
          )}
        </Field>
        {error ? <Alert variant="error">{error}</Alert> : null}
        {waitMs > 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-400" role="status">
            Too many wrong passwords. Try again in {formatWait(Math.ceil(waitMs / 1000))}.
          </p>
        ) : null}
        <Button type="submit" fullWidth loading={pending} disabled={waitMs > 0}>
          {pending ? "Unlocking…" : "Unlock"}
        </Button>
      </form>
      <p className="text-center text-sm">
        <button
          type="button"
          className="text-brand-700 hover:underline dark:text-brand-300"
          onClick={() => void logout(queryClient, () => router.navigate({ to: "/login" }))}
        >
          Log out
        </button>
      </p>
    </AuthLayout>
  );
}
