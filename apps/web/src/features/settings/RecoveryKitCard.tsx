import { apiPaths, replaceRecoveryResponseSchema } from "@pm/shared";
import { useState } from "react";
import { Alert, Button, Card, Dialog } from "../../components/ui/index.ts";
import { cryptoClient } from "../../crypto-worker/client.ts";
import { api } from "../../lib/api.ts";
import { describeError } from "../../lib/errors.ts";
import { useRequiredUser } from "../../lib/session.ts";
import { RecoveryKitScreen } from "../auth/RecoveryKitScreen.tsx";

interface NewKit {
  phrase: string;
  material: { wrappedAkRec: string; recoveryAuthKey: string };
}

/** Regenerate the recovery kit. The old phrase stops working only after the new one is confirmed. */
export function RecoveryKitCard() {
  const user = useRequiredUser();
  const [confirming, setConfirming] = useState(false);
  const [kit, setKit] = useState<NewKit | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function generate() {
    setPending(true);
    setError(null);
    try {
      const { recoveryPhrase, material } = await cryptoClient.call("buildRecoveryKit");
      setKit({ phrase: recoveryPhrase, material });
      setConfirming(false);
      setDone(false);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  if (kit) {
    return (
      <Card title="New recovery kit">
        <RecoveryKitScreen
          phrase={kit.phrase}
          email={user.email}
          confirmLabel="Replace my recovery kit"
          skipLabel="Cancel"
          onSkip={() => setKit(null)}
          onConfirmed={async () => {
            await api.post(apiPaths.me.recovery, {
              body: kit.material,
              schema: replaceRecoveryResponseSchema,
            });
            setKit(null);
            setDone(true);
          }}
        />
      </Card>
    );
  }

  return (
    <Card
      title="Recovery kit"
      description="24 words that let you get back in if you forget your master password. Generating a new kit makes the old one stop working."
    >
      {done ? <Alert variant="success">Your new recovery kit is active.</Alert> : null}
      {error ? <Alert variant="error">{error}</Alert> : null}
      <Button variant="secondary" onClick={() => setConfirming(true)}>
        Generate a new recovery kit
      </Button>
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Replace your recovery kit?"
        description="Your current kit stays valid until you confirm the new one on the next screen."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button loading={pending} onClick={() => void generate()}>
              Generate
            </Button>
          </>
        }
      />
    </Card>
  );
}
