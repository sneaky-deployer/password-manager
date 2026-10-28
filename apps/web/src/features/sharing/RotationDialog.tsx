import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Dialog, Spinner } from "../../components/ui/index.ts";
import { describeVaultError } from "../vault/errors.ts";
import { REVOKE_NOTICE, type RotationProgress, runVaultRotation } from "./rotation.ts";

interface RotationDialogProps {
  open: boolean;
  vaultId: string;
  /** True when the rotation follows a member removal in this session: shows the revoke notice. */
  afterRemoval?: boolean;
  onClose: () => void;
}

const PHASE_TEXT: Record<RotationProgress["phase"], string> = {
  syncing: "Checking the latest state of the vault",
  preparing: "Re-encrypting the vault with a new key",
  uploading: "Uploading re-encrypted items",
  finalizing: "Switching the vault to the new key",
  done: "Done",
};

/**
 * Runs the key rotation for a vault and shows its progress. It starts when it opens; if it fails
 * (network, a concurrent change) the vault stays marked "rotation pending" and Retry starts over.
 */
export function RotationDialog({
  open,
  vaultId,
  afterRemoval = false,
  onClose,
}: RotationDialogProps) {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<RotationProgress>({
    phase: "syncing",
    uploaded: 0,
    total: 0,
  });
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const started = useRef(false);

  const run = useCallback(async () => {
    setError(null);
    setRunning(true);
    setProgress({ phase: "syncing", uploaded: 0, total: 0 });
    try {
      await runVaultRotation(queryClient, vaultId, setProgress);
    } catch (err) {
      setError(describeVaultError(err, "The rotation did not finish."));
    } finally {
      setRunning(false);
    }
  }, [queryClient, vaultId]);

  useEffect(() => {
    if (!open) {
      started.current = false;
      return;
    }
    if (started.current) return;
    started.current = true;
    void run();
  }, [open, run]);

  const done = progress.phase === "done" && !error;

  return (
    <Dialog
      open={open}
      onClose={running ? () => undefined : onClose}
      dismissible={!running}
      title={done ? "Vault key rotated" : "Rotating the vault key"}
      description={
        done
          ? undefined
          : "Keep this page open. If it gets interrupted, the vault stays locked for changes until you finish it."
      }
      footer={
        error ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            <Button onClick={() => void run()}>Retry</Button>
          </>
        ) : (
          <Button variant={done ? "primary" : "secondary"} disabled={running} onClick={onClose}>
            {done ? "Done" : "Close"}
          </Button>
        )
      }
    >
      {error ? (
        <Alert variant="error" title="The rotation did not finish">
          {error} The vault stays paused for edits until a manager finishes the rotation.
        </Alert>
      ) : done ? (
        <div className="space-y-3">
          <Alert variant="success">All items were re-encrypted under a new key.</Alert>
          {afterRemoval ? <p className="text-sm">{REVOKE_NOTICE}</p> : null}
        </div>
      ) : (
        <div className="flex items-center gap-3" aria-live="polite">
          <Spinner label="" className="size-5" />
          <div className="text-sm">
            <p>{PHASE_TEXT[progress.phase]}</p>
            {progress.total > 0 ? (
              <p className="text-slate-600 dark:text-slate-400">
                {progress.uploaded} of {progress.total} items
              </p>
            ) : null}
          </div>
        </div>
      )}
    </Dialog>
  );
}
