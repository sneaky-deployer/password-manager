import {
  acceptShareResponseSchema,
  apiPaths,
  declineShareResponseSchema,
  type PendingShare,
} from "@pm/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, Badge, Button, Card, EmptyState, Spinner } from "../../components/ui/index.ts";
import { cryptoClient } from "../../crypto-worker/client.ts";
import { api } from "../../lib/api.ts";
import { formatRelative } from "../../lib/format.ts";
import { describeVaultError } from "../vault/errors.ts";
import { usePendingShares } from "../vault/hooks.ts";
import { ROLE_LABELS, vaultDotClass } from "../vault/item-utils.ts";
import { PENDING_SHARES_KEY, syncNow } from "../vault/sync.ts";

/** Invitations to vaults and single items, with the decrypted vault name and who invited me. */
export function InvitationsPage() {
  const pending = usePendingShares();
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold">Invitations</h1>
      {pending.isPending ? (
        <Spinner label="Loading invitations" className="size-6" />
      ) : pending.isError ? (
        <Alert variant="error">
          {describeVaultError(pending.error)}{" "}
          <Button size="sm" variant="secondary" onClick={() => void pending.refetch()}>
            Try again
          </Button>
        </Alert>
      ) : pending.data.shares.length === 0 ? (
        <EmptyState title="No invitations">
          When someone shares a vault or an item with you, it shows up here.
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {pending.data.shares.map((share) => (
            <li key={share.id}>
              <InvitationCard share={share} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function InvitationCard({ share }: { share: PendingShare }) {
  const queryClient = useQueryClient();
  const view = useQuery({
    queryKey: ["vault", "pending-view", share.id],
    queryFn: () => cryptoClient.call("openPendingShare", { pending: share }),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function respond(answer: "accept" | "decline") {
    setBusy(answer);
    setError(null);
    try {
      if (answer === "accept") {
        await api.post(apiPaths.shares.accept(share.id), { schema: acceptShareResponseSchema });
      } else {
        await api.post(apiPaths.shares.decline(share.id), { schema: declineShareResponseSchema });
      }
      await queryClient.invalidateQueries({ queryKey: PENDING_SHARES_KEY });
      await syncNow(queryClient);
    } catch (err) {
      setError(describeVaultError(err));
      void queryClient.invalidateQueries({ queryKey: PENDING_SHARES_KEY });
    } finally {
      setBusy(null);
    }
  }

  const title =
    share.kind === "vault"
      ? view.data && view.data.kind === "vault"
        ? view.data.name
        : "Shared vault"
      : "Shared item";

  return (
    <Card
      as="h3"
      title={
        <span className="flex items-center gap-2">
          {share.kind === "vault" && view.data?.kind === "vault" ? (
            <span
              aria-hidden="true"
              className={`size-3 rounded-full ${vaultDotClass(view.data.color)}`}
            />
          ) : null}
          {title}
        </span>
      }
      description={
        <>
          From <strong>{share.invitedByEmail}</strong> · {formatRelative(share.createdAt)}
        </>
      }
      actions={
        <Badge tone="brand">
          {share.kind === "vault" ? "Vault" : "Item"} · {ROLE_LABELS[share.role]}
        </Badge>
      }
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            variant="secondary"
            loading={busy === "decline"}
            disabled={busy !== null}
            onClick={() => void respond("decline")}
          >
            Decline
          </Button>
          <Button
            loading={busy === "accept"}
            disabled={busy !== null}
            onClick={() => void respond("accept")}
          >
            Accept
          </Button>
        </div>
      }
    >
      {share.kind === "item" ? (
        <p className="text-sm text-slate-600 dark:text-slate-400">
          You will see this item under “Shared with me”. Its name is shown once you accept.
        </p>
      ) : view.data && !view.data.readable ? (
        <Alert variant="warning">
          The vault name could not be decrypted. Accepting is still possible, but ask the sender if
          this looks wrong.
        </Alert>
      ) : (
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Accepting adds this vault to your sidebar as {ROLE_LABELS[share.role].toLowerCase()}.
        </p>
      )}
      {error ? <Alert variant="error">{error}</Alert> : null}
    </Card>
  );
}
