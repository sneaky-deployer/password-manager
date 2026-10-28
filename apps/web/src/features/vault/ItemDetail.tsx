import type { ItemContent } from "@pm/shared";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  CopyButton,
  Dialog,
  EmptyState,
  Select,
  Spinner,
} from "../../components/ui/index.ts";
import type { ItemListView, VaultView } from "../../crypto-worker/vault-protocol.ts";
import { formatDateTime } from "../../lib/format.ts";
import { ShareItemDialog } from "../sharing/ShareItemDialog.tsx";
import { TotpCode } from "../totp/index.ts";
import { Avatar } from "./Avatar.tsx";
import { deleteItemAction, moveItemAction, restoreItemAction, trashItemAction } from "./actions.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { describeVaultError } from "./errors.ts";
import { writableVaults } from "./filters.ts";
import { useItem, useVaults } from "./hooks.ts";
import { displayHost, ROLE_LABELS, safeHttpUrl } from "./item-utils.ts";
import { WorkspaceLink } from "./workspace-nav.tsx";

interface ItemDetailProps {
  itemId: string;
  /** Called after the item left this view (trashed, deleted, moved away). */
  onGone: () => void;
}

/** Everything about one item. The decrypted content is requested from the worker on open. */
export function ItemDetail({ itemId, onGone }: ItemDetailProps) {
  const { vaults } = useVaults();
  const { summary, detail, isLoading, notFound, error } = useItem(itemId);

  if (isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Spinner label="Loading item" className="size-6" />
      </div>
    );
  }
  if (notFound || !summary) {
    return (
      <EmptyState title="Item not found">
        It may have been deleted or moved, or you no longer have access.
      </EmptyState>
    );
  }
  const vault = vaults.find((v) => v.id === summary.vaultId);

  return (
    <article className="space-y-5" aria-label={summary.name}>
      <BackLink />
      <header className="flex items-start gap-3">
        <Avatar name={summary.name} readable={summary.readable} className="size-12 text-xl" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xl font-semibold">{summary.name}</h2>
          <p className="flex flex-wrap items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
            {summary.sharedWithMe ? (
              <Badge tone="brand">Shared with you</Badge>
            ) : vault ? (
              <span>{vault.name}</span>
            ) : null}
            {summary.trashed ? <Badge tone="warning">In trash</Badge> : null}
            {summary.shareCount > 0 ? (
              <Badge>
                Shared with {summary.shareCount} {summary.shareCount === 1 ? "person" : "people"}
              </Badge>
            ) : null}
          </p>
        </div>
      </header>

      {vault?.rotationPending ? (
        <Alert variant="warning" title="Waiting for a key rotation">
          A member was removed from this vault. Changes to items are paused until a manager finishes
          the rotation.
        </Alert>
      ) : null}

      <Actions summary={summary} vault={vault} vaults={vaults} onGone={onGone} />

      {!detail?.content ? (
        <Alert variant="error" title="This item cannot be read">
          It could not be decrypted or is in a format this version does not understand. The data was
          not changed. Item id: <code className="font-mono text-xs">{summary.id}</code>
          {error ? <span className="mt-1 block">{describeVaultError(error)}</span> : null}
        </Alert>
      ) : (
        <Content content={detail.content} />
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t border-slate-200 pt-4 text-xs text-slate-600 dark:border-slate-800 dark:text-slate-400">
        <dt>Created</dt>
        <dd>{formatDateTime(summary.createdAt)}</dd>
        <dt>Last updated</dt>
        <dd>{formatDateTime(summary.updatedAt)}</dd>
      </dl>
    </article>
  );
}

function BackLink() {
  return (
    <WorkspaceLink
      search={{}}
      className="inline-block text-sm text-brand-700 hover:underline lg:hidden dark:text-brand-300"
    >
      Back to list
    </WorkspaceLink>
  );
}

function Content({ content }: { content: ItemContent }) {
  if (content.type === "note") {
    return (
      <Row label="Note">
        <p className="whitespace-pre-wrap break-words text-sm">{content.notes || "Empty note"}</p>
      </Row>
    );
  }
  return (
    <div className="space-y-4">
      {content.username ? (
        <Row label="Username" copy={content.username}>
          <span className="break-all text-sm">{content.username}</span>
        </Row>
      ) : null}
      {content.password ? <SecretRow label="Password" value={content.password} /> : null}
      {content.totp ? (
        <Row label="One-time code">
          <TotpCode uri={content.totp} />
        </Row>
      ) : null}
      {content.urls.length > 0 ? (
        <Row label={content.urls.length > 1 ? "Websites" : "Website"}>
          <ul className="space-y-1">
            {content.urls.map((url) => (
              <UrlLine key={url} url={url} />
            ))}
          </ul>
        </Row>
      ) : null}
      {content.notes ? (
        <Row label="Notes">
          <p className="whitespace-pre-wrap break-words text-sm">{content.notes}</p>
        </Row>
      ) : null}
      {content.customFields.map((field, index) =>
        field.hidden ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: fields have no id; the list is static here
          <SecretRow key={index} label={field.label || "Hidden field"} value={field.value} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: fields have no id; the list is static here
          <Row key={index} label={field.label || "Field"} copy={field.value}>
            <span className="break-all text-sm">{field.value}</span>
          </Row>
        ),
      )}
    </div>
  );
}

function Row({
  label,
  copy,
  children,
}: {
  label: string;
  copy?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-slate-600 dark:text-slate-400">{label}</p>
        <div className="mt-0.5">{children}</div>
      </div>
      {copy !== undefined ? (
        <CopyButton value={copy} label="Copy" aria-label={`Copy ${label.toLowerCase()}`} />
      ) : null}
    </div>
  );
}

/** A value hidden behind dots until the user reveals it. */
function SecretRow({ label, value }: { label: string; value: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-slate-600 dark:text-slate-400">{label}</p>
        <p className="mt-0.5 break-all font-mono text-sm" data-testid={`secret-${label}`}>
          {shown ? value : "••••••••••••"}
        </p>
      </div>
      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          aria-pressed={shown}
          aria-label={`${shown ? "Hide" : "Reveal"} ${label.toLowerCase()}`}
          onClick={() => setShown((v) => !v)}
        >
          {shown ? "Hide" : "Reveal"}
        </Button>
        <CopyButton value={value} aria-label={`Copy ${label.toLowerCase()}`} />
      </div>
    </div>
  );
}

function UrlLine({ url }: { url: string }) {
  const safe = safeHttpUrl(url);
  return (
    <li className="flex items-center justify-between gap-3">
      {safe ? (
        <a
          href={safe}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all text-sm text-brand-700 hover:underline dark:text-brand-300"
        >
          {displayHost(url)}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ) : (
        <span className="break-all text-sm">{url}</span>
      )}
      <CopyButton value={url} autoClear={false} aria-label={`Copy ${displayHost(url)}`} />
    </li>
  );
}

function Actions({
  summary,
  vault,
  vaults,
  onGone,
}: {
  summary: ItemListView;
  vault: VaultView | undefined;
  vaults: VaultView[];
  onGone: () => void;
}) {
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [moving, setMoving] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const paused = vault?.rotationPending ?? false;
  const targets = writableVaults(vaults).filter((v) => v.id !== summary.vaultId);

  async function run(action: () => Promise<void>, leave: boolean) {
    setBusy(true);
    setError(null);
    try {
      await action();
      if (leave) onGone();
    } catch (err) {
      setError(describeVaultError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {summary.trashed && summary.canManage ? (
          <>
            <Button
              variant="secondary"
              loading={busy}
              onClick={() => void run(() => restoreItemAction(queryClient, summary.id), true)}
            >
              Restore
            </Button>
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              Delete forever
            </Button>
          </>
        ) : summary.trashed ? (
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Only editors can restore or delete items.
          </p>
        ) : (
          <>
            {summary.canEdit && summary.readable ? (
              <WorkspaceLink
                search={{ item: summary.id, mode: "edit" }}
                aria-disabled={paused}
                className={`inline-flex h-10 items-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 ${paused ? "pointer-events-none opacity-60" : ""}`}
              >
                Edit
              </WorkspaceLink>
            ) : null}
            {summary.canShare && summary.readable ? (
              <Button variant="secondary" disabled={paused} onClick={() => setSharing(true)}>
                Share
              </Button>
            ) : null}
            {summary.canManage && targets.length > 0 ? (
              <Button
                variant="secondary"
                disabled={paused || summary.shareCount > 0}
                title={
                  summary.shareCount > 0 ? "Revoke the item's shares before moving it" : undefined
                }
                onClick={() => setMoving(true)}
              >
                Move
              </Button>
            ) : null}
            {summary.canManage ? (
              <Button
                variant="ghost"
                loading={busy}
                onClick={() => void run(() => trashItemAction(queryClient, summary.id), true)}
              >
                Move to trash
              </Button>
            ) : null}
          </>
        )}
      </div>
      {error ? <Alert variant="error">{error}</Alert> : null}

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this item forever?"
        description="It will be permanently removed for everyone who has access. This cannot be undone."
        confirmLabel="Delete forever"
        danger
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          await deleteItemAction(queryClient, summary.id);
          onGone();
        }}
      />
      <MoveDialog
        open={moving}
        targets={targets}
        onClose={() => setMoving(false)}
        onMove={async (targetVaultId) => {
          await moveItemAction(queryClient, { id: summary.id, targetVaultId });
          onGone();
        }}
      />
      <ShareItemDialog open={sharing} itemId={summary.id} onClose={() => setSharing(false)} />
    </div>
  );
}

function MoveDialog({
  open,
  targets,
  onClose,
  onMove,
}: {
  open: boolean;
  targets: VaultView[];
  onClose: () => void;
  onMove: (targetVaultId: string) => Promise<void>;
}) {
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = target || targets[0]?.id || "";

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onMove(chosen);
      onClose();
    } catch (err) {
      setError(describeVaultError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Move to another vault"
      description="The item keeps its content; only the vault key that protects it changes."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!chosen} onClick={() => void submit()}>
            Move
          </Button>
        </>
      }
    >
      <label className="block space-y-1.5 text-sm font-medium" htmlFor="move-target">
        Target vault
        <Select id="move-target" value={chosen} onChange={(event) => setTarget(event.target.value)}>
          {targets.map((vault) => (
            <option key={vault.id} value={vault.id}>
              {vault.name} ({ROLE_LABELS[vault.myRole]})
            </option>
          ))}
        </Select>
      </label>
      {error ? <Alert variant="error">{error}</Alert> : null}
    </Dialog>
  );
}
