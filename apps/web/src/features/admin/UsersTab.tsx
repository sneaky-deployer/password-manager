import {
  type AdminUserWire,
  apiPaths,
  deleteUserResponseSchema,
  listUsersResponseSchema,
  resetUserResponseSchema,
  type UpdateUserRequest,
  updateUserResponseSchema,
} from "@pm/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Spinner,
} from "../../components/ui/index.ts";
import { api, isApiError } from "../../lib/api.ts";
import { describeError } from "../../lib/errors.ts";
import { formatDate, formatRelative } from "../../lib/format.ts";
import { useRequiredUser } from "../../lib/session.ts";
import { INVITES_QUERY_KEY } from "./InvitesTab.tsx";

const USERS_QUERY_KEY = ["admin", "users"] as const;

type Confirm = { kind: "reset" | "delete"; user: AdminUserWire } | null;

/** PLAN.md 10.1a: list users, disable/enable, promote/demote, reset account, delete. */
export function UsersTab() {
  const me = useRequiredUser();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const users = useQuery({
    queryKey: USERS_QUERY_KEY,
    queryFn: ({ signal }) =>
      api.get(apiPaths.admin.users, { schema: listUsersResponseSchema, signal }),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEY });

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateUserRequest }) =>
      api.patch(apiPaths.admin.user(id), { body: patch, schema: updateUserResponseSchema }),
    onSuccess: refresh,
  });
  const reset = useMutation({
    mutationFn: (id: string) =>
      api.post(apiPaths.admin.userReset(id), { schema: resetUserResponseSchema }),
    onSuccess: (result) => {
      setNotice(
        `${result.invite.email} was reset and received an invitation to set a new password.`,
      );
      void queryClient.invalidateQueries({ queryKey: INVITES_QUERY_KEY });
      return refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api.delete(apiPaths.admin.user(id), { schema: deleteUserResponseSchema }),
    onSuccess: refresh,
  });

  const mutationError = update.error ?? reset.error ?? remove.error;

  function runConfirmed() {
    if (!confirm) return;
    const { kind, user } = confirm;
    setNotice(null);
    const mutation = kind === "reset" ? reset : remove;
    mutation.mutate(user.id, { onSettled: () => setConfirm(null) });
  }

  return (
    <Card title="Users" description="Metadata only. Admins cannot see anyone's vault contents.">
      {mutationError ? (
        <Alert variant="error">
          {isApiError(mutationError, "last_admin")
            ? "You cannot demote or disable the last admin. Promote someone else first."
            : describeError(mutationError)}
        </Alert>
      ) : null}
      {notice ? <Alert variant="success">{notice}</Alert> : null}
      {users.isPending ? (
        <Spinner label="Loading users" />
      ) : users.isError ? (
        <Alert variant="error">{describeError(users.error)}</Alert>
      ) : users.data.users.length === 0 ? (
        <EmptyState title="No users" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Users</caption>
            <thead className="text-xs uppercase text-slate-600 dark:text-slate-400">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Email
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Role
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Status
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  2FA
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Last sign-in
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {users.data.users.map((user) => {
                const self = user.id === me.id;
                const busy = update.isPending && update.variables?.id === user.id;
                return (
                  <tr key={user.id}>
                    <td className="py-3 pr-4">
                      {user.email}
                      {self ? <span className="ml-2 text-xs text-slate-500">(you)</span> : null}
                      <div className="text-xs text-slate-500">
                        Joined {formatDate(user.createdAt)}
                      </div>
                    </td>
                    <td className="py-3 pr-4">
                      <Badge tone={user.role === "admin" ? "brand" : "neutral"}>{user.role}</Badge>
                    </td>
                    <td className="py-3 pr-4">
                      <Badge tone={user.status === "active" ? "success" : "warning"}>
                        {user.status}
                      </Badge>
                    </td>
                    <td className="py-3 pr-4">{user.twoFactorEnabled ? "On" : "Off"}</td>
                    <td className="py-3 pr-4 text-slate-600 dark:text-slate-400">
                      {user.lastLoginAt ? formatRelative(user.lastLoginAt) : "Never"}
                    </td>
                    <td className="py-3 text-right">
                      <div className="flex flex-wrap justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          aria-label={`${user.role === "admin" ? "Demote" : "Promote"} ${user.email}`}
                          onClick={() => {
                            setNotice(null);
                            update.mutate({
                              id: user.id,
                              patch: { role: user.role === "admin" ? "user" : "admin" },
                            });
                          }}
                        >
                          {user.role === "admin" ? "Demote" : "Promote"}
                        </Button>
                        {self ? null : (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              aria-label={`${user.status === "active" ? "Disable" : "Enable"} ${user.email}`}
                              onClick={() => {
                                setNotice(null);
                                update.mutate({
                                  id: user.id,
                                  patch: {
                                    status: user.status === "active" ? "disabled" : "active",
                                  },
                                });
                              }}
                            >
                              {user.status === "active" ? "Disable" : "Enable"}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`Reset account of ${user.email}`}
                              onClick={() => setConfirm({ kind: "reset", user })}
                            >
                              Reset
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`Delete ${user.email}`}
                              onClick={() => setConfirm({ kind: "delete", user })}
                            >
                              Delete
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm?.kind === "reset" ? "Reset this account?" : "Delete this user?"}
        description={
          confirm?.kind === "reset"
            ? `${confirm.user.email} will lose all items in their vaults permanently, 2FA and passkeys are removed, and they get an email to set a new password. Use this only when they lost their recovery kit.`
            : confirm
              ? `${confirm.user.email} and every vault and item they own will be permanently deleted.`
              : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={reset.isPending || remove.isPending}
              onClick={runConfirmed}
            >
              {confirm?.kind === "reset" ? "Reset account" : "Delete user"}
            </Button>
          </>
        }
      />
    </Card>
  );
}
