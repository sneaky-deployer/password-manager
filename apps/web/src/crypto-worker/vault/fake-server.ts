import type {
  CreateItemRequest,
  CreateVaultRequest,
  ItemShareWire,
  ItemWire,
  SyncResponse,
  UpdateItemRequest,
  VaultMemberWire,
  VaultRole,
  VaultWire,
} from "@pm/shared";

/**
 * A tiny in-memory stand-in for the API's data, used by the worker tests to build `GET /sync`
 * responses from the request bodies the worker produced. It does not enforce roles; the tests
 * assert the worker's own checks. Test-only: nothing in the app imports this file.
 */
export class FakeServer {
  clock = 1_000_000;
  users = new Map<string, { email: string; publicKey: string }>();
  vaults = new Map<string, VaultWire>();
  members = new Map<string, VaultMemberWire>();
  items = new Map<string, ItemWire>();
  shares = new Map<string, ItemShareWire>();

  tick(): number {
    this.clock += 10;
    return this.clock;
  }

  addUser(id: string, email: string, publicKey: string): void {
    this.users.set(id, { email, publicKey });
  }

  private user(userId: string) {
    const user = this.users.get(userId);
    if (!user) throw new Error(`unknown user ${userId}`);
    return user;
  }

  /** `POST /vaults` */
  createVault(ownerId: string, body: CreateVaultRequest): VaultWire {
    const now = this.tick();
    const vault: VaultWire = {
      id: body.id,
      ownerId,
      keyVersion: 1,
      encryptedMeta: body.encryptedMeta,
      rotationPending: false,
      myRole: "owner",
      createdAt: now,
      updatedAt: now,
    };
    this.vaults.set(vault.id, vault);
    this.addMember(vault.id, ownerId, "owner", body.sealedKey, 1, "active");
    return vault;
  }

  addMember(
    vaultId: string,
    userId: string,
    role: VaultRole,
    sealedKey: string,
    keyVersion: number,
    status: "pending" | "active" = "active",
  ): VaultMemberWire {
    const now = this.tick();
    const user = this.user(userId);
    const member: VaultMemberWire = {
      id: crypto.randomUUID(),
      vaultId,
      userId,
      email: user.email,
      publicKey: user.publicKey,
      role,
      status,
      keyVersion,
      invitedBy: null,
      sealedKey,
      createdAt: now,
      updatedAt: now,
    };
    this.members.set(member.id, member);
    return member;
  }

  memberOf(vaultId: string, userId: string): VaultMemberWire {
    for (const member of this.members.values()) {
      if (member.vaultId === vaultId && member.userId === userId) return member;
    }
    throw new Error("no such member");
  }

  /** `POST /items` */
  createItem(userId: string, body: CreateItemRequest): ItemWire {
    const now = this.tick();
    const item: ItemWire = {
      ...body,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      trashedAt: null,
      createdBy: userId,
      updatedBy: userId,
    };
    this.items.set(item.id, item);
    return item;
  }

  /** `PUT /items/:id` (member path, with item key rotation when `itemKeyVersion` grows). */
  updateItem(userId: string, id: string, body: UpdateItemRequest): ItemWire {
    const current = this.items.get(id);
    if (!current) throw new Error("no such item");
    if (body.revision !== current.revision) throw new Error("revision_conflict");
    const now = this.tick();
    const next: ItemWire = {
      ...current,
      itemKeyVersion: body.itemKeyVersion,
      wrappedKey: body.wrappedKey,
      vaultKeyVersion: body.vaultKeyVersion,
      encryptedData: body.encryptedData,
      revision: current.revision + 1,
      updatedBy: userId,
      updatedAt: now,
    };
    this.items.set(id, next);
    for (const entry of body.shareKeys ?? []) {
      const share = this.shares.get(entry.shareId);
      if (!share) throw new Error("unknown share");
      this.shares.set(share.id, {
        ...share,
        sealedKey: entry.sealedKey,
        keyVersion: body.itemKeyVersion,
        updatedAt: now,
      });
    }
    return next;
  }

  trashItem(id: string, trashed: boolean): ItemWire {
    const current = this.items.get(id);
    if (!current) throw new Error("no such item");
    const now = this.tick();
    const next = { ...current, trashedAt: trashed ? now : null, updatedAt: now };
    this.items.set(id, next);
    return next;
  }

  /** `POST /items/:id/shares` */
  shareItem(
    itemId: string,
    userId: string,
    role: "viewer" | "editor",
    sealedKey: string,
    keyVersion: number,
    status: "pending" | "active" = "active",
  ): ItemShareWire {
    const item = this.items.get(itemId);
    if (!item) throw new Error("no such item");
    const now = this.tick();
    const user = this.user(userId);
    const share: ItemShareWire = {
      id: crypto.randomUUID(),
      itemId,
      vaultId: item.vaultId,
      userId,
      email: user.email,
      publicKey: user.publicKey,
      role,
      status,
      keyVersion,
      invitedBy: null,
      sealedKey,
      createdAt: now,
      updatedAt: now,
    };
    this.shares.set(share.id, share);
    return share;
  }

  /** The rows a user's `GET /sync` returns for a full sync (or all rows, for an overlap test). */
  sync(userId: string, extra: Partial<SyncResponse> = {}): SyncResponse {
    const mine = [...this.members.values()].filter(
      (member) => member.userId === userId && member.status === "active",
    );
    const myVaultIds = new Set(mine.map((member) => member.vaultId));
    const myShares = [...this.shares.values()].filter(
      (share) => share.userId === userId && share.status === "active",
    );
    const sharedItemIds = new Set(myShares.map((share) => share.itemId));

    const vaults = mine.flatMap((member) => {
      const vault = this.vaults.get(member.vaultId);
      return vault ? [{ ...vault, myRole: member.role }] : [];
    });
    const members = [...this.members.values()]
      .filter((member) => myVaultIds.has(member.vaultId))
      .map((member) => {
        const { sealedKey, ...rest } = member;
        return member.userId === userId ? member : (rest as VaultMemberWire);
      });
    const items = [...this.items.values()].filter(
      (item) => myVaultIds.has(item.vaultId) || sharedItemIds.has(item.id),
    );
    const itemShares = [...this.shares.values()]
      .filter((share) => {
        if (share.userId === userId) return share.status === "active";
        const item = this.items.get(share.itemId);
        return item ? myVaultIds.has(item.vaultId) : false;
      })
      .map((share) => {
        if (share.userId === userId) return share;
        const { sealedKey, ...rest } = share;
        return rest as ItemShareWire;
      });
    return {
      serverTime: this.clock,
      full: true,
      vaults,
      members,
      items,
      itemShares,
      deletions: [],
      ...extra,
    };
  }
}
