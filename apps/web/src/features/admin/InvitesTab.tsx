import {
  apiPaths,
  createInviteResponseSchema,
  emailSchema,
  type InviteStatus,
  type InviteWire,
  listInvitesResponseSchema,
  resendInviteResponseSchema,
  revokeInviteResponseSchema,
} from "@pm/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  Alert,
  Badge,
  type BadgeTone,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Spinner,
} from "../../components/ui/index.ts";
import { api } from "../../lib/api.ts";
import { describeError } from "../../lib/errors.ts";
import { formatDateTime } from "../../lib/format.ts";

export const INVITES_QUERY_KEY = ["admin", "invites"] as const;

const STATUS_TONE: Record<InviteStatus, BadgeTone> = {
  pending: "brand",
  accepted: "success",
  expired: "warning",
  revoked: "neutral",
};

/** PLAN.md 10.1 / 10.1a: invite by email, list, resend, revoke. */
export function InvitesTab() {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const invites = useQuery({
    queryKey: INVITES_QUERY_KEY,
    queryFn: ({ signal }) =>
      api.get(apiPaths.admin.invites, { schema: listInvitesResponseSchema, signal }),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: INVITES_QUERY_KEY });

  const create = useMutation({
    mutationFn: (address: string) =>
      api.post(apiPaths.admin.invites, {
        body: { email: address },
        schema: createInviteResponseSchema,
      }),
    onSuccess: (result) => {
      setEmail("");
      setNotice(`Invitation sent to ${result.invite.email}.`);
      return refresh();
    },
  });
  const resend = useMutation({
    mutationFn: (id: string) =>
      api.post(apiPaths.admin.inviteResend(id), { schema: resendInviteResponseSchema }),
    onSuccess: (result) => {
      setNotice(`A new link was sent to ${result.invite.email}. The old link no longer works.`);
      return refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api.post(apiPaths.admin.inviteRevoke(id), { schema: revokeInviteResponseSchema }),
    onSuccess: (result) => {
      setNotice(`Invitation for ${result.invite.email} revoked.`);
      return refresh();
    },
  });

  function submit() {
    setNotice(null);
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      setEmailError("Enter a valid email address.");
      return;
    }
    setEmailError(null);
    create.mutate(parsed.data);
  }

  const error = create.error ?? resend.error ?? revoke.error;

  return (
    <>
      <Card
        title="Invite someone"
        description="They get an email with a link that is valid for 72 hours."
      >
        <form
          className="flex flex-wrap items-start gap-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Field label="Email address" error={emailError} className="min-w-64 flex-1">
            {(control) => (
              <Input
                {...control}
                type="email"
                autoComplete="off"
                inputMode="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            )}
          </Field>
          <Button type="submit" className="mt-[1.65rem]" loading={create.isPending}>
            Send invite
          </Button>
        </form>
        {error ? <Alert variant="error">{describeError(error)}</Alert> : null}
        {notice ? <Alert variant="success">{notice}</Alert> : null}
      </Card>

      <Card title="Invitations">
        {invites.isPending ? (
          <Spinner label="Loading invitations" />
        ) : invites.isError ? (
          <Alert variant="error">{describeError(invites.error)}</Alert>
        ) : invites.data.invites.length === 0 ? (
          <EmptyState title="No invitations yet">Invite someone with the form above.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Invitations</caption>
              <thead className="text-xs uppercase text-slate-600 dark:text-slate-400">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Email
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Status
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Expires
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {invites.data.invites.map((invite) => (
                  <InviteRow
                    key={invite.id}
                    invite={invite}
                    busy={
                      (resend.isPending && resend.variables === invite.id) ||
                      (revoke.isPending && revoke.variables === invite.id)
                    }
                    onResend={() => {
                      setNotice(null);
                      resend.mutate(invite.id);
                    }}
                    onRevoke={() => {
                      setNotice(null);
                      revoke.mutate(invite.id);
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function InviteRow({
  invite,
  busy,
  onResend,
  onRevoke,
}: {
  invite: InviteWire;
  busy: boolean;
  onResend: () => void;
  onRevoke: () => void;
}) {
  const canResend = invite.status === "pending" || invite.status === "expired";
  return (
    <tr>
      <td className="py-3 pr-4">
        {invite.email}
        {invite.kind === "account_reset" ? (
          <span className="ml-2">
            <Badge tone="warning">Account reset</Badge>
          </span>
        ) : null}
        {invite.role === "admin" ? (
          <span className="ml-2">
            <Badge tone="brand">Admin</Badge>
          </span>
        ) : null}
      </td>
      <td className="py-3 pr-4">
        <Badge tone={STATUS_TONE[invite.status]}>{invite.status}</Badge>
      </td>
      <td className="py-3 pr-4 text-slate-600 dark:text-slate-400">
        {formatDateTime(invite.expiresAt)}
      </td>
      <td className="py-3 text-right">
        <div className="flex justify-end gap-1">
          {canResend ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              aria-label={`Resend invite to ${invite.email}`}
              onClick={onResend}
            >
              Resend
            </Button>
          ) : null}
          {invite.status === "pending" ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              aria-label={`Revoke invite for ${invite.email}`}
              onClick={onRevoke}
            >
              Revoke
            </Button>
          ) : null}
        </div>
      </td>
    </tr>
  );
}
