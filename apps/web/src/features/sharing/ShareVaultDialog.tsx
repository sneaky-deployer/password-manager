import {
  apiPaths,
  inviteMemberResponseSchema,
  removeMemberResponseSchema,
  updateMemberResponseSchema,
  type VaultInviteRole,
} from "@pm/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, Badge, Button, Dialog, Select } from "../../components/ui/index.ts";
import { cryptoClient } from "../../crypto-worker/client.ts";
import type { MemberView, VaultView } from "../../crypto-worker/vault-protocol.ts";
import { api } from "../../lib/api.ts";
import { ConfirmDialog } from "../vault/ConfirmDialog.tsx";
import { describeVaultError } from "../vault/errors.ts";
import { useMembers, useVaults } from "../vault/hooks.ts";
import { ROLE_LABELS } from "../vault/item-utils.ts";
import { syncNow } from "../vault/sync.ts";
import { InviteForm } from "./InviteForm.tsx";
import { RotationDialog } from "./RotationDialog.tsx";

const ALL_ROLES: ReadonlyArray<{ value: VaultInviteRole; label: string }> = [
  { value: "viewer", label: "Viewer: can read items" },
  { value: "editor", label: "Editor: can read and change items" },
  { value: "manager", label: "Manager: can also invite and remove people" },
];

/** What I may do with `target`: managers handle viewers and editors, only the owner handles managers. */
function canManageMember(vault: VaultView, target: MemberView): boolean {
  if (target.isMe || target.role === "owner") return false;
  if (vault.myRole === "owner") return true;
  return vault.myRole === "manager" && target.role !== "manager";
}

interface ShareVaultDialogProps {
  open: boolean;
  vaultId: string;
  onClose: () => void;
}

/** Members of a vault, invitations, role changes and removal (which rotates the vault key). */
export function ShareVaultDialog({ open, vaultId, onClose }: ShareVaultDialogProps) {
  const { vaults } = useVaults();
  const vault = vaults.find((v) => v.id === vaultId);
  const members = useMembers(vaultId);
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState<MemberView | null>(null);
  const [rotation, setRotation] = useState<{ afterRemoval: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!vault) return null;
  const canManage = vault.myRole === "owner" || vault.myRole === "manager";
  const inviteRoles =
    vault.myRole === "owner" ? ALL_ROLES : ALL_ROLES.filter((r) => r.value !== "manager");

  async function invite(
    recipient: { userId: string; publicKey: string },
    role: VaultInviteRole,
  ): Promise<void> {
    const { keyVersion, sealedKey } = await cryptoClient.call("sealVaultKeyFor", {
      vaultId,
      publicKey: recipient.publicKey,
    });
    await api.post(apiPaths.vaults.members(vaultId), {
      body: { userId: recipient.userId, role, keyVersion, sealedKey },
      schema: inviteMemberResponseSchema,
    });
    await syncNow(queryClient);
  }

  async function changeRole(member: MemberView, role: VaultInviteRole) {
    setError(null);
    try {
      await api.patch(apiPaths.vaults.member(vaultId, member.id), {
        body: { role },
        schema: updateMemberResponseSchema,
      });
      await syncNow(queryClient);
    } catch (err) {
      setError(describeVaultError(err));
    }
  }

  async function remove(member: MemberView) {
    await api.delete(apiPaths.vaults.member(vaultId, member.id), {
      schema: removeMemberResponseSchema,
    });
    // The server marked the vault `rotationPending`; run the rotation right away.
    setRotation({ afterRemoval: true });
  }

  return (
    <>
      <Dialog
        open={open && rotation === null}
        onClose={onClose}
        title={`Share “${vault.name}”`}
        description="People you invite can read this vault's items. Removing someone rotates the vault key."
        footer={
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        }
      >
        {vault.rotationPending ? (
          <Alert variant="warning" title="Key rotation unfinished">
            A member was removed but the vault key has not been rotated yet. Until it is, nobody can
            change items.
            {canManage ? (
              <div className="mt-3">
                <Button size="sm" onClick={() => setRotation({ afterRemoval: false })}>
                  Finish rotation
                </Button>
              </div>
            ) : (
              <span> A manager needs to finish it.</span>
            )}
          </Alert>
        ) : null}

        <section aria-label="Members" className="space-y-2">
          <h3 className="text-sm font-semibold">Members</h3>
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {members.map((member) => (
              <li key={member.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="min-w-0 flex-1 truncate text-sm">
                  {member.email}
                  {member.isMe ? " (you)" : ""}
                </span>
                {member.status === "pending" ? <Badge tone="warning">Invited</Badge> : null}
                {canManageMember(vault, member) ? (
                  <>
                    <Select
                      aria-label={`Role of ${member.email}`}
                      className="w-32"
                      value={member.role}
                      onChange={(event) =>
                        void changeRole(member, event.target.value as VaultInviteRole)
                      }
                    >
                      <option value="viewer">Viewer</option>
                      <option value="editor">Editor</option>
                      {vault.myRole === "owner" ? <option value="manager">Manager</option> : null}
                    </Select>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove ${member.email}`}
                      onClick={() => setRemoving(member)}
                    >
                      Remove
                    </Button>
                  </>
                ) : (
                  <Badge tone={member.role === "owner" ? "brand" : "neutral"}>
                    {ROLE_LABELS[member.role]}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
          {error ? <Alert variant="error">{error}</Alert> : null}
        </section>

        {canManage && !vault.rotationPending ? (
          <section aria-label="Invite" className="space-y-2">
            <h3 className="text-sm font-semibold">Invite someone</h3>
            <InviteForm roles={inviteRoles} submitLabel="Send invitation" onInvite={invite} />
          </section>
        ) : null}
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        title={`Remove ${removing?.email ?? "this person"}?`}
        description="They lose access immediately. The vault key is then replaced and every item re-encrypted so the old key is useless."
        confirmLabel="Remove and rotate key"
        danger
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (removing) await remove(removing);
        }}
      />

      <RotationDialog
        open={rotation !== null}
        vaultId={vaultId}
        afterRemoval={rotation?.afterRemoval ?? false}
        onClose={() => setRotation(null)}
      />
    </>
  );
}

/** Banner for a vault that still needs its key rotation, with a button to finish it. */
export function RotationBanner({ vault }: { vault: VaultView }) {
  const [open, setOpen] = useState(false);
  if (!vault.rotationPending) return null;
  const canFinish = vault.myRole === "owner" || vault.myRole === "manager";
  return (
    <Alert variant="warning" title="This vault is waiting for a key rotation">
      A member was removed, so the vault key must be replaced before items can change again.
      {canFinish ? (
        <div className="mt-3">
          <Button size="sm" onClick={() => setOpen(true)}>
            Finish rotation
          </Button>
        </div>
      ) : (
        <span> A manager or the owner needs to finish it.</span>
      )}
      <RotationDialog open={open} vaultId={vault.id} onClose={() => setOpen(false)} />
    </Alert>
  );
}
