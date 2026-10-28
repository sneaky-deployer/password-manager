/**
 * Every API route as a path string, so the client and the server never hardcode them. Functions
 * build parameterised paths; pass a Hono pattern such as `":id"` to get the route pattern
 * (`apiPaths.items.item(":id")` -> `/api/items/:id`) or a real id to get a URL.
 */
export const API_PREFIX = "/api";

const p = (path: string) => `${API_PREFIX}${path}`;

export const apiPaths = {
  health: p("/health"),

  setup: {
    status: p("/setup/status"),
    start: p("/setup/start"),
  },

  invites: {
    inspect: p("/invites/inspect"),
  },

  auth: {
    acceptInvite: p("/auth/accept-invite"),
    emailStart: p("/auth/email/start"),
    prelogin: p("/auth/prelogin"),
    login: p("/auth/login"),
    twoFactorVerify: p("/auth/2fa/verify"),
    webauthnOptions: p("/auth/webauthn/options"),
    recoveryStart: p("/auth/recovery/start"),
    recoveryComplete: p("/auth/recovery/complete"),
    resetAccount: p("/auth/reset-account"),
    logout: p("/auth/logout"),
  },

  me: {
    root: p("/me"),
    keys: p("/me/keys"),
    emailCode: p("/me/email-code"),
    password: p("/me/password"),
    passwordResetFromUnlocked: p("/me/password/reset-from-unlocked"),
    recovery: p("/me/recovery"),
    kdfUpgrade: p("/me/kdf-upgrade"),
    sessions: p("/me/sessions"),
    session: (id: string) => p(`/me/sessions/${id}`),
    totpSetup: p("/me/2fa/totp/setup"),
    totpEnable: p("/me/2fa/totp/enable"),
    totpDisable: p("/me/2fa/totp/disable"),
    webauthn: p("/me/2fa/webauthn"),
    webauthnRegisterOptions: p("/me/2fa/webauthn/register/options"),
    webauthnRegisterVerify: p("/me/2fa/webauthn/register/verify"),
    webauthnCredential: (id: string) => p(`/me/2fa/webauthn/${id}`),
    backupCodes: p("/me/2fa/backup-codes"),
    activity: p("/me/activity"),
    settings: p("/me/settings"),
  },

  admin: {
    invites: p("/admin/invites"),
    inviteResend: (id: string) => p(`/admin/invites/${id}/resend`),
    inviteRevoke: (id: string) => p(`/admin/invites/${id}/revoke`),
    users: p("/admin/users"),
    user: (id: string) => p(`/admin/users/${id}`),
    userReset: (id: string) => p(`/admin/users/${id}/reset`),
  },

  sync: p("/sync"),

  vaults: {
    root: p("/vaults"),
    vault: (id: string) => p(`/vaults/${id}`),
    members: (id: string) => p(`/vaults/${id}/members`),
    member: (id: string, memberId: string) => p(`/vaults/${id}/members/${memberId}`),
    rotate: (id: string) => p(`/vaults/${id}/rotate`),
    leave: (id: string) => p(`/vaults/${id}/leave`),
  },

  items: {
    root: p("/items"),
    item: (id: string) => p(`/items/${id}`),
    trash: (id: string) => p(`/items/${id}/trash`),
    restore: (id: string) => p(`/items/${id}/restore`),
    move: (id: string) => p(`/items/${id}/move`),
    shares: (id: string) => p(`/items/${id}/shares`),
    share: (id: string, shareId: string) => p(`/items/${id}/shares/${shareId}`),
  },

  shares: {
    pending: p("/shares/pending"),
    accept: (id: string) => p(`/shares/${id}/accept`),
    decline: (id: string) => p(`/shares/${id}/decline`),
  },

  users: {
    lookup: p("/users/lookup"),
  },
} as const;
