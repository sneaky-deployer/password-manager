import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Badge, Menu, type MenuItem } from "../../components/ui/index.ts";
import type { VaultView } from "../../crypto-worker/vault-protocol.ts";
import { cn } from "../../lib/cn.ts";
import { ShareVaultDialog } from "../sharing/ShareVaultDialog.tsx";
import { deleteVaultAction, leaveVaultAction } from "./actions.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { ROLE_LABELS, vaultDotClass } from "./item-utils.ts";
import { VaultFormDialog } from "./VaultFormDialog.tsx";

/** Title of a vault view with its role and the vault menu (share, rename, delete, leave). */
export function VaultHeader({ vault }: { vault: VaultView }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [sharing, setSharing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const canManage = vault.myRole === "owner" || vault.myRole === "manager";
  const items: MenuItem[] = [
    {
      key: "share",
      label: canManage ? "Share and members…" : "Members…",
      onSelect: () => setSharing(true),
    },
    ...(canManage ? [{ key: "rename", label: "Rename…", onSelect: () => setRenaming(true) }] : []),
    ...(vault.isOwner
      ? [
          {
            key: "delete",
            label: "Delete vault…",
            tone: "danger" as const,
            onSelect: () => setDeleting(true),
          },
        ]
      : [
          {
            key: "leave",
            label: "Leave vault…",
            tone: "danger" as const,
            onSelect: () => setLeaving(true),
          },
        ]),
  ];

  const goAll = () => void navigate({ to: "/vault", search: {} });

  return (
    <div className="flex flex-wrap items-center gap-3">
      <span aria-hidden="true" className={cn("size-3 rounded-full", vaultDotClass(vault.color))} />
      <h1 className="min-w-0 truncate text-2xl font-semibold">{vault.name}</h1>
      <Badge tone={vault.isOwner ? "brand" : "neutral"}>{ROLE_LABELS[vault.myRole]}</Badge>
      {vault.memberCount > 1 ? <Badge>{vault.memberCount} members</Badge> : null}
      <div className="ml-auto">
        <Menu label="Vault menu" trigger={<span>Vault…</span>} items={items} />
      </div>

      <ShareVaultDialog open={sharing} vaultId={vault.id} onClose={() => setSharing(false)} />
      {renaming ? <VaultFormDialog open vault={vault} onClose={() => setRenaming(false)} /> : null}
      <ConfirmDialog
        open={deleting}
        title={`Delete “${vault.name}”?`}
        description={
          vault.memberCount > 1
            ? "All items in it are deleted for every member, including the people it is shared with. This cannot be undone."
            : "All items in it are deleted permanently. This cannot be undone."
        }
        confirmLabel="Delete vault"
        danger
        onClose={() => setDeleting(false)}
        onConfirm={async () => {
          await deleteVaultAction(queryClient, vault.id);
          goAll();
        }}
      />
      <ConfirmDialog
        open={leaving}
        title={`Leave “${vault.name}”?`}
        description="You lose access to its items. The owner can invite you again."
        confirmLabel="Leave vault"
        danger
        onClose={() => setLeaving(false)}
        onConfirm={async () => {
          await leaveVaultAction(queryClient, vault.id);
          goAll();
        }}
      />
    </div>
  );
}
