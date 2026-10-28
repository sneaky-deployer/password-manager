import { apiPaths, backupCodesResponseSchema } from "@pm/shared";
import { useState } from "react";
import { Alert, Button, Card, Dialog } from "../../components/ui/index.ts";
import { api } from "../../lib/api.ts";
import { describeError } from "../../lib/errors.ts";
import { useRequiredUser } from "../../lib/session.ts";
import { BackupCodesDialog } from "./BackupCodesDialog.tsx";

/** Regenerate the 10 single-use backup codes (shown once). Only offered when 2FA is on. */
export function BackupCodesCard() {
  const user = useRequiredUser();
  const hasTwoFactor = user.twoFactor.totp || user.twoFactor.webauthn > 0;
  const [confirming, setConfirming] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function regenerate() {
    setPending(true);
    setError(null);
    try {
      const result = await api.post(apiPaths.me.backupCodes, { schema: backupCodesResponseSchema });
      setCodes(result.backupCodes);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setConfirming(false);
      setPending(false);
    }
  }

  return (
    <Card
      title="Backup codes"
      description="Single-use codes for signing in or recovering your account if you lose your authenticator or passkey."
    >
      {!hasTwoFactor ? (
        <Alert variant="info">Turn on an authenticator app or add a passkey first.</Alert>
      ) : (
        <>
          {error ? <Alert variant="error">{error}</Alert> : null}
          <Button variant="secondary" onClick={() => setConfirming(true)}>
            Generate new backup codes
          </Button>
        </>
      )}
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Generate new backup codes?"
        description="Your existing backup codes will stop working."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button loading={pending} onClick={() => void regenerate()}>
              Generate
            </Button>
          </>
        }
      />
      <BackupCodesDialog codes={codes} email={user.email} onClose={() => setCodes(null)} />
    </Card>
  );
}
