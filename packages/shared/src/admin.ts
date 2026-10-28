import { z } from "zod";
import { INVITE_KINDS, INVITE_STATUSES, USER_ROLES, USER_STATUSES } from "./constants.ts";
import { emailSchema, okResponseSchema, timestampSchema, uuidSchema } from "./primitives.ts";

/** Invite as shown in the admin list. `status` is derived (expired = past `expiresAt`). */
export const inviteWireSchema = z.strictObject({
  id: uuidSchema,
  email: emailSchema,
  role: z.enum(USER_ROLES),
  kind: z.enum(INVITE_KINDS),
  status: z.enum(INVITE_STATUSES),
  invitedBy: uuidSchema.nullable(),
  expiresAt: timestampSchema,
  acceptedAt: timestampSchema.nullable(),
  revokedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
});
export type InviteWire = z.infer<typeof inviteWireSchema>;

/** User as shown to admins: metadata only (PLAN.md 10.1a). */
export const adminUserWireSchema = z.strictObject({
  id: uuidSchema,
  email: emailSchema,
  role: z.enum(USER_ROLES),
  status: z.enum(USER_STATUSES),
  invitedBy: uuidSchema.nullable(),
  twoFactorEnabled: z.boolean(),
  lastLoginAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
});
export type AdminUserWire = z.infer<typeof adminUserWireSchema>;

/** `GET /admin/invites` */
export const listInvitesResponseSchema = z.strictObject({ invites: z.array(inviteWireSchema) });
export type ListInvitesResponse = z.infer<typeof listInvitesResponseSchema>;

/** `POST /admin/invites` (role is always `user`; promote afterwards with `PATCH /admin/users/:id`). */
export const createInviteRequestSchema = z.strictObject({ email: emailSchema });
export type CreateInviteRequest = z.infer<typeof createInviteRequestSchema>;
export const createInviteResponseSchema = z.strictObject({ invite: inviteWireSchema });
export type CreateInviteResponse = z.infer<typeof createInviteResponseSchema>;

/** `POST /admin/invites/:id/resend` (new token, old one invalidated) */
export const resendInviteResponseSchema = createInviteResponseSchema;
export type ResendInviteResponse = z.infer<typeof resendInviteResponseSchema>;

/** `POST /admin/invites/:id/revoke` */
export const revokeInviteResponseSchema = createInviteResponseSchema;
export type RevokeInviteResponse = z.infer<typeof revokeInviteResponseSchema>;

/** `GET /admin/users` */
export const listUsersResponseSchema = z.strictObject({ users: z.array(adminUserWireSchema) });
export type ListUsersResponse = z.infer<typeof listUsersResponseSchema>;

/** `PATCH /admin/users/:id`: role and/or status, at least one. */
export const updateUserRequestSchema = z
  .strictObject({
    role: z.enum(USER_ROLES).optional(),
    status: z.enum(USER_STATUSES).optional(),
  })
  .refine((value) => value.role !== undefined || value.status !== undefined, {
    message: "Provide role or status",
  });
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;
export const updateUserResponseSchema = z.strictObject({ user: adminUserWireSchema });
export type UpdateUserResponse = z.infer<typeof updateUserResponseSchema>;

/** `POST /admin/users/:id/reset`: wipes account data and sends an `account_reset` invite. */
export const resetUserResponseSchema = createInviteResponseSchema;
export type ResetUserResponse = z.infer<typeof resetUserResponseSchema>;

/** `DELETE /admin/users/:id` */
export const deleteUserResponseSchema = okResponseSchema;
export type DeleteUserResponse = z.infer<typeof deleteUserResponseSchema>;
