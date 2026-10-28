import { apiPaths, type ItemShareRole, shareItemResponseSchema } from "@pm/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, Badge, Button, Dialog } from "../../components/ui/index.ts";
import { cryptoClient } from "../../crypto-worker/client.ts";
import type { ItemShareView } from "../../crypto-worker/vault-protocol.ts";
import { api } from "../../lib/api.ts";
import { ConfirmDialog } from "../vault/ConfirmDialog.tsx";
import { describeVaultError } from "../vault/errors.ts";
import { useItem, useItemShares } from "../vault/hooks.ts";
import { ROLE_LABELS } from "../vault/item-utils.ts";
import { syncNow } from "../vault/sync.ts";
import { InviteForm } from "./InviteForm.tsx";
import { REVOKE_NOTICE, revokeItemShare, rotateItemKey } from "./rotation.ts";

const ROLES: ReadonlyArray<{ value: ItemShareRole; label: string }> = [
  { value: "viewer", label: "Viewer: can read the item" },
  { value: "editor", label: "Editor: can read and change the item" },
];

interface ShareItemDialogProps {
  open: boolean;
  itemId: string;
  onClose: () => void;
}

/** Share one item with a person who is not in its vault, and revoke shares (which rotates the item key). */
export function ShareItemDialog({ open, itemId, onClose }: ShareItemDialogProps) {
  const queryClient = useQueryClient();
  const { summary } = useItem(itemId);
  const shares = useItemShares(itemId);
  const [revoking, setRevoking] = useState<ItemShareView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Set when the share is gone but the key rotation failed: Retry runs only the rotation. */
  const [unfinished, setUnfinished] = useState<{ shareId: string; error: string } | null>(null);

  async function invite(
    recipient: { userId: string; publicKey: string },
    role: ItemShareRole,
  ): Promise<void> {
    setNotice(null);
    const { keyVersion, sealedKey } = await cryptoClient.call("sealItemKeyFor", {
      itemId,
      publicKey: recipient.publicKey,
    });
    await api.post(apiPaths.items.shares(itemId), {
      body: { userId: recipient.userId, role, keyVersion, sealedKey },
      schema: shareItemResponseSchema,
    });
    await syncNow(queryClient);
  }

  async function revoke(share: ItemShareView) {
    setNotice(null);
    setUnfinished(null);
    try {
      await revokeItemShare(queryClient, itemId, share.id);
      setNotice(REVOKE_NOTICE);
    } catch (error) {
      // The share may already be deleted; if so only the rotation is left to do.
      await syncNow(queryClient).catch(() => undefined);
      setUnfinished({ shareId: share.id, error: describeVaultError(error) });
      throw error;
    }
  }

  async function retryRotation() {
    if (!unfinished) return;
    try {
      await rotateItemKey(queryClient, itemId, unfinished.shareId);
      setUnfinished(null);
      setNotice(REVOKE_NOTICE);
    } catch (error) {
      setUnfinished({ shareId: unfinished.shareId, error: describeVaultError(error) });
    }
  }

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        title={`Share “${summary?.name ?? "item"}”`}
        description="The person gets this one item and nothing else from its vault. They must have an account."
        footer={
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        }
      >
        {notice ? <Alert variant="success">{notice}</Alert> : null}
        {unfinished ? (
          <Alert variant="error" title="Access was removed, but the item key was not replaced yet">
            {unfinished.error}
            <div className="mt-3">
              <Button size="sm" onClick={() => void retryRotation()}>
                Retry
              </Button>
            </div>
          </Alert>
        ) : null}

        <section aria-label="People with access" className="space-y-2">
          <h3 className="text-sm font-semibold">Shared with</h3>
          {shares.length === 0 ? (
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Not shared with anyone yet.
            </p>
          ) : (
            <ul className="divide-y divide-slate-200 dark:divide-slate-800">
              {shares.map((share) => (
                <li key={share.id} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm">{share.email}</span>
                  {share.status === "pending" ? <Badge tone="warning">Invited</Badge> : null}
                  <Badge>{ROLE_LABELS[share.role]}</Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Revoke access of ${share.email}`}
                    onClick={() => setRevoking(share)}
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Invite" className="space-y-2">
          <h3 className="text-sm font-semibold">Share with someone</h3>
          <InviteForm roles={ROLES} submitLabel="Share item" onInvite={invite} />
        </section>
      </Dialog>

      <ConfirmDialog
        open={revoking !== null}
        title={`Revoke access of ${revoking?.email ?? "this person"}?`}
        description="They lose access now. The item gets a new key so the one they hold stops working."
        confirmLabel="Revoke access"
        danger
        onClose={() => setRevoking(null)}
        onConfirm={async () => {
          if (revoking) await revoke(revoking);
        }}
      />
    </>
  );
}
