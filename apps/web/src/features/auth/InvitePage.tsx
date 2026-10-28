import { acceptInviteResponseSchema, apiPaths, inspectInviteResponseSchema } from "@pm/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Alert, Button, Field, Input, Spinner } from "../../components/ui/index.ts";
import { cryptoClient } from "../../crypto-worker/client.ts";
import { api, isApiError } from "../../lib/api.ts";
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

let capturedToken: string | null = null;

/**
 * Reads `#t=<token>` from the address bar and remembers it in memory, because the fragment is
 * stripped right after (a remount must still find the token). Cleared once the invite is used.
 */
function readToken(): string | null {
  const hash = window.location.hash.replace(/^#/, "");
  const fromHash = new URLSearchParams(hash).get("t");
  if (fromHash) capturedToken = fromHash;
  return capturedToken;
}

/** Forget the in-memory token (after use, and between tests). */
export function forgetInviteToken(): void {
  capturedToken = null;
}

/** Removes the fragment from the address bar so the token is not left in history or screenshots. */
function stripHash(): void {
  if (!window.location.hash) return;
  window.history.replaceState(
    window.history.state,
    "",
    window.location.pathname + window.location.search,
  );
}

type Stage = "form" | "creating" | "kit";

/** PLAN.md 10.1 "Invitee accepts" (and the `account_reset` variant). */
export function InvitePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [token] = useState(readToken);

  useEffect(() => stripHash(), []);

  const inspect = useQuery({
    queryKey: ["invite", "inspect"],
    enabled: Boolean(token),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: ({ signal }) =>
      api.post(apiPaths.invites.inspect, {
        body: { token: token },
        schema: inspectInviteResponseSchema,
        signal,
      }),
  });

  const [stage, setStage] = useState<Stage>("form");
  const [password, setPassword] = useState<NewPasswordValue>(EMPTY_NEW_PASSWORD);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phrase, setPhrase] = useState<string | null>(null);

  if (!token || isApiError(inspect.error, "invite_invalid")) {
    return (
      <AuthLayout title="This invite link does not work">
        <p className="text-sm">
          The link is invalid, has expired, or was already used. Ask your administrator to send a
          new invite.
        </p>
        <Button variant="secondary" onClick={() => void navigate({ to: "/login" })}>
          Go to sign in
        </Button>
      </AuthLayout>
    );
  }

  if (inspect.isPending) {
    return (
      <AuthLayout title="Invitation">
        <div className="flex justify-center py-6">
          <Spinner label="Checking your invitation" />
        </div>
      </AuthLayout>
    );
  }

  if (inspect.isError) {
    return (
      <AuthLayout title="Invitation">
        <Alert variant="error">{describeError(inspect.error)}</Alert>
        <Button onClick={() => void inspect.refetch()}>Try again</Button>
      </AuthLayout>
    );
  }

  const invite = inspect.data;
  const isReset = invite.kind === "account_reset";

  if (stage === "kit" && phrase) {
    return (
      <AuthLayout
        wide
        title="Save your recovery kit"
        subtitle="Your account is ready. One last step before you continue."
      >
        <RecoveryKitScreen
          phrase={phrase}
          email={invite.email}
          confirmLabel="I saved it, open my vault"
          onConfirmed={() => {
            setPhrase(null);
            void navigate({ to: "/" });
          }}
        />
      </AuthLayout>
    );
  }

  async function submit() {
    setSubmitted(true);
    setError(null);
    if (validateNewPassword(password, [invite.email])) return;
    setStage("creating");
    try {
      const { creation, recoveryPhrase } = await cryptoClient.call("createAccount", {
        password: password.password,
        vaultName: "Personal",
      });
      const { user } = await api.post(apiPaths.auth.acceptInvite, {
        body: { token: token, ...creation },
        schema: acceptInviteResponseSchema,
      });
      await cryptoClient.call("commitAccountCreation");
      setPassword(EMPTY_NEW_PASSWORD);
      forgetInviteToken();
      setSessionUser(queryClient, user);
      markUnlocked();
      setPhrase(recoveryPhrase);
      setStage("kit");
    } catch (err) {
      await cryptoClient.call("lock").catch(() => {});
      setStage("form");
      setError(describeError(err));
    }
  }

  const creating = stage === "creating";

  return (
    <AuthLayout
      title={isReset ? "Set a new master password" : "Create your account"}
      subtitle={
        invite.invitedBy
          ? `${invite.invitedBy} invited you to Password Manager.`
          : "You are setting up the first administrator account."
      }
    >
      {isReset ? (
        <Alert variant="info" title="Your account was reset">
          An administrator reset this account, so your previous items were deleted. Choose a new
          master password to start again with an empty vault.
        </Alert>
      ) : null}

      {creating ? (
        <div className="flex flex-col items-center gap-3 py-8" role="status">
          <Spinner label="" className="size-8 text-brand-600" />
          <p className="font-medium">Securing your account…</p>
          <p className="text-center text-sm text-slate-600 dark:text-slate-400">
            Your keys are being created in this browser. This takes a few seconds.
          </p>
        </div>
      ) : (
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Field label="Email">
            {(control) => <Input {...control} type="email" value={invite.email} readOnly />}
          </Field>
          <NewPasswordFields
            value={password}
            onChange={setPassword}
            userInputs={[invite.email]}
            showErrors={submitted}
          />
          <Alert variant="warning" title="Nobody can reset this password">
            Not even the administrator. If you forget it, only your recovery kit (shown next) can
            get your data back.
          </Alert>
          {error ? <Alert variant="error">{error}</Alert> : null}
          <Button type="submit" fullWidth>
            {isReset ? "Set password" : "Create account"}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
