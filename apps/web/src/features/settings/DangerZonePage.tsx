import {
  apiPaths,
  deleteAccountResponseSchema,
  emailCodeSchema,
  meEmailCodeResponseSchema,
  meKeysResponseSchema,
} from "@pm/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import {
  Alert,
  Button,
  Card,
  Dialog,
  Field,
  Input,
  PasswordInput,
} from "../../components/ui/index.ts";
import { cryptoClient, isCryptoError } from "../../crypto-worker/client.ts";
import { CRYPTO_ERROR } from "../../crypto-worker/protocol.ts";
import { api } from "../../lib/api.ts";
import { describeError } from "../../lib/errors.ts";
import { lockNow, useRequiredUser } from "../../lib/session.ts";

const CONFIRM_WORD = "DELETE";

/** Delete own account: email code + current password + typed confirmation. */
export function DangerZonePage() {
  const user = useRequiredUser();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <Card
      title="Delete account"
      description="Permanently deletes your account, every vault you own and all their items. Vaults shared with others are deleted for them too."
    >
      <Alert variant="warning">
        This cannot be undone. Export anything you need first. Your recovery kit will not help
        afterwards.
      </Alert>
      <Button variant="danger" onClick={() => setOpen(true)}>
        Delete my account…
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Delete your account?">
        <DeleteForm
          email={user.email}
          onCancel={() => setOpen(false)}
          onDeleted={async () => {
            await router.navigate({ to: "/login", replace: true });
            await lockNow();
            queryClient.clear();
          }}
        />
      </Dialog>
    </Card>
  );
}

function DeleteForm({
  email,
  onCancel,
  onDeleted,
}: {
  email: string;
  onCancel: () => void;
  onDeleted: () => Promise<void>;
}) {
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    setError(null);
    const parsed = emailCodeSchema.safeParse(code);
    if (!parsed.success) return setError("Enter the 6-digit code from the email.");
    if (!password) return setError("Enter your master password.");
    if (confirmation.trim() !== CONFIRM_WORD) return setError(`Type ${CONFIRM_WORD} to confirm.`);
    setPending(true);
    try {
      const keyBundle = await api.get(apiPaths.me.keys, { schema: meKeysResponseSchema });
      const { authKey } = await cryptoClient.call("deriveAuthKey", { password, keyBundle });
      await api.delete(apiPaths.me.root, {
        body: { currentAuthKey: authKey, emailCode: parsed.data },
        schema: deleteAccountResponseSchema,
      });
      await onDeleted();
    } catch (err) {
      setError(
        isCryptoError(err, CRYPTO_ERROR.wrongPassword)
          ? "That is not your master password."
          : describeError(err),
      );
      setPending(false);
    }
  }

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="text-sm">
        For {email}. We email a code first, then ask for your master password.
      </p>
      {codeSent ? (
        <>
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
          <Field label="Master password">
            {(control) => (
              <PasswordInput
                {...control}
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            )}
          </Field>
          <Field label={`Type ${CONFIRM_WORD} to confirm`}>
            {(control) => (
              <Input
                {...control}
                autoComplete="off"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            )}
          </Field>
        </>
      ) : null}
      {error ? <Alert variant="error">{error}</Alert> : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        {codeSent ? (
          <Button type="submit" variant="danger" loading={pending}>
            Delete account
          </Button>
        ) : (
          <Button loading={pending} onClick={() => void sendCode()}>
            Email me a code
          </Button>
        )}
      </div>
    </form>
  );
}
