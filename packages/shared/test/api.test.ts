import { describe, expect, it } from "vitest";
import {
  acceptInviteRequestSchema,
  accountCreationSchema,
  apiPaths,
  createItemRequestSchema,
  createVaultRequestSchema,
  itemWireSchema,
  loginResponseSchema,
  recoveryStartRequestSchema,
  rotateVaultRequestSchema,
  syncResponseSchema,
  twoFactorVerifyRequestSchema,
  updateItemRequestSchema,
  updateSettingsRequestSchema,
} from "../src/index.ts";
import {
  accountCreation,
  envelope,
  itemWire,
  keyBundle,
  meSummary,
  rand,
  sealedBox,
  uuid,
} from "./fixtures.ts";

describe("accept-invite", () => {
  const body = () => ({ token: rand(32), ...accountCreation() });

  it("parses a realistic body with the contract field names", () => {
    const fixture = body();
    expect(acceptInviteRequestSchema.parse(fixture)).toEqual(fixture);
    expect(accountCreationSchema.safeParse(accountCreation()).success).toBe(true);
  });

  it("rejects missing fields", () => {
    const { token: _token, ...noToken } = body();
    expect(acceptInviteRequestSchema.safeParse(noToken).success).toBe(false);

    const noRecovery = body();
    (noRecovery.user as Partial<typeof noRecovery.user>).recoveryAuthKey = undefined;
    expect(acceptInviteRequestSchema.safeParse(noRecovery).success).toBe(false);

    const { vault: _vault, ...noVault } = body();
    expect(acceptInviteRequestSchema.safeParse(noVault).success).toBe(false);
  });

  it("rejects extra fields at every level", () => {
    expect(acceptInviteRequestSchema.safeParse({ ...body(), extra: 1 }).success).toBe(false);

    const userExtra = body();
    Object.assign(userExtra.user, { password: "hunter2" });
    expect(acceptInviteRequestSchema.safeParse(userExtra).success).toBe(false);

    const vaultExtra = body();
    Object.assign(vaultExtra.vault, { name: "Personal" });
    expect(acceptInviteRequestSchema.safeParse(vaultExtra).success).toBe(false);
  });

  it("rejects wrong lengths and key versions", () => {
    const shortAuth = body();
    shortAuth.user.authKey = rand(31);
    expect(acceptInviteRequestSchema.safeParse(shortAuth).success).toBe(false);

    const shortSalt = body();
    shortSalt.user.salt = rand(32);
    expect(acceptInviteRequestSchema.safeParse(shortSalt).success).toBe(false);

    const v2 = body();
    v2.vault.keyVersion = 2;
    expect(acceptInviteRequestSchema.safeParse(v2).success).toBe(false);
  });
});

describe("login response", () => {
  it("discriminates on status", () => {
    const ok = { status: "ok", user: meSummary(), keys: keyBundle() };
    const parsedOk = loginResponseSchema.parse(ok);
    expect(parsedOk.status).toBe("ok");

    const tf = {
      status: "two_factor_required",
      challengeToken: rand(32),
      methods: ["totp", "backup_code"],
    };
    const parsedTf = loginResponseSchema.parse(tf);
    expect(parsedTf.status).toBe("two_factor_required");
    if (parsedTf.status === "two_factor_required") expect(parsedTf.methods).toHaveLength(2);
  });

  it("rejects mixed or unknown shapes", () => {
    expect(loginResponseSchema.safeParse({ status: "ok", challengeToken: rand(32) }).success).toBe(
      false,
    );
    expect(
      loginResponseSchema.safeParse({
        status: "two_factor_required",
        challengeToken: rand(32),
        methods: ["sms"],
      }).success,
    ).toBe(false);
    expect(loginResponseSchema.safeParse({ status: "weird" }).success).toBe(false);
  });
});

describe("two-factor and recovery requests", () => {
  it("discriminates the 2fa verify body on method", () => {
    expect(
      twoFactorVerifyRequestSchema.safeParse({
        challengeToken: rand(32),
        method: "totp",
        code: "123456",
      }).success,
    ).toBe(true);
    expect(
      twoFactorVerifyRequestSchema.safeParse({
        challengeToken: rand(32),
        method: "totp",
        code: "12345",
      }).success,
    ).toBe(false);
    expect(
      twoFactorVerifyRequestSchema.safeParse({
        challengeToken: rand(32),
        method: "backup_code",
        code: "ab12-cd34",
      }).success,
    ).toBe(true);
  });

  it("treats recovery 2FA as optional", () => {
    const base = { email: "A@Example.com", emailCode: "123456", recoveryAuthKey: rand(32) };
    expect(recoveryStartRequestSchema.parse(base).email).toBe("a@example.com");
    expect(
      recoveryStartRequestSchema.safeParse({
        ...base,
        twoFactor: { method: "totp", code: "123456" },
      }).success,
    ).toBe(true);
  });
});

describe("items and vaults", () => {
  it("validates the wire item and create/update bodies", () => {
    const wire = itemWire();
    expect(itemWireSchema.parse(wire)).toEqual(wire);

    const create = {
      id: wire.id,
      vaultId: wire.vaultId,
      itemKeyVersion: 1,
      wrappedKey: wire.wrappedKey,
      vaultKeyVersion: 1,
      encryptedData: wire.encryptedData,
    };
    expect(createItemRequestSchema.parse(create)).toEqual(create);
    expect(createItemRequestSchema.safeParse({ ...create, revision: 1 }).success).toBe(false);

    const { id: _id, vaultId: _vaultId, ...rest } = create;
    expect(updateItemRequestSchema.safeParse({ ...rest, revision: 4 }).success).toBe(true);
    expect(updateItemRequestSchema.safeParse(rest).success).toBe(false);
    expect(updateItemRequestSchema.safeParse({ ...rest, revision: 0 }).success).toBe(false);
  });

  it("validates vault creation", () => {
    const body = {
      id: uuid(),
      keyVersion: 1,
      encryptedMeta: envelope(40),
      sealedKey: sealedBox(),
    };
    expect(createVaultRequestSchema.safeParse(body).success).toBe(true);
    expect(createVaultRequestSchema.safeParse({ ...body, keyVersion: 2 }).success).toBe(false);
  });

  it("validates rotation chunks and finalisation", () => {
    const entry = () => ({
      id: uuid(),
      revision: 2,
      itemKeyVersion: 2,
      wrappedKey: envelope(),
      vaultKeyVersion: 4,
      encryptedData: envelope(300),
    });
    const chunk = (n: number) => ({
      step: "chunk",
      newKeyVersion: 4,
      items: Array.from({ length: n }, entry),
    });
    expect(rotateVaultRequestSchema.safeParse(chunk(100)).success).toBe(true);
    expect(rotateVaultRequestSchema.safeParse(chunk(101)).success).toBe(false);
    expect(rotateVaultRequestSchema.safeParse(chunk(0)).success).toBe(false);

    const finalize = {
      step: "finalize",
      newKeyVersion: 4,
      encryptedMeta: envelope(40),
      memberKeys: [{ memberId: uuid(), sealedKey: sealedBox() }],
      itemShareKeys: [],
    };
    expect(rotateVaultRequestSchema.safeParse(finalize).success).toBe(true);
    expect(rotateVaultRequestSchema.safeParse({ ...finalize, memberKeys: [] }).success).toBe(false);
  });
});

describe("settings, sync and paths", () => {
  it("requires at least one setting", () => {
    expect(updateSettingsRequestSchema.safeParse({}).success).toBe(false);
    expect(updateSettingsRequestSchema.safeParse({ autoLockMinutes: 5 }).success).toBe(true);
    expect(updateSettingsRequestSchema.safeParse({ autoLockMinutes: 0 }).success).toBe(false);
    expect(updateSettingsRequestSchema.safeParse({ theme: "neon" }).success).toBe(false);
  });

  it("parses a sync response", () => {
    const vaultId = uuid();
    const me = uuid();
    const sync = {
      serverTime: 1_700_000_000_000,
      full: true,
      vaults: [
        {
          id: vaultId,
          ownerId: me,
          keyVersion: 1,
          encryptedMeta: envelope(40),
          rotationPending: false,
          myRole: "owner",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      members: [
        {
          id: uuid(),
          vaultId,
          userId: me,
          email: "me@example.com",
          publicKey: rand(32),
          role: "owner",
          status: "active",
          keyVersion: 1,
          invitedBy: null,
          sealedKey: sealedBox(),
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      items: [itemWire()],
      itemShares: [],
      deletions: [{ entity: "item", id: uuid(), deletedAt: 5 }],
    };
    expect(syncResponseSchema.parse(sync)).toEqual(sync);
    expect(
      syncResponseSchema.safeParse({
        ...sync,
        deletions: [{ entity: "user", id: uuid(), deletedAt: 5 }],
      }).success,
    ).toBe(false);
  });

  it("builds route paths", () => {
    expect(apiPaths.auth.login).toBe("/api/auth/login");
    expect(apiPaths.items.item("abc")).toBe("/api/items/abc");
    expect(apiPaths.items.item(":id")).toBe("/api/items/:id");
    expect(apiPaths.vaults.member("v", "m")).toBe("/api/vaults/v/members/m");
  });
});
