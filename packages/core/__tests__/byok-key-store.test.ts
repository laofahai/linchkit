import { describe, expect, test } from "bun:test";
import { createInMemoryBYOKKeyStore } from "../src/ai/byok-key-store";

describe("createInMemoryBYOKKeyStore", () => {
  // ── CRUD basics ─────────────────────────────────────────

  test("putKey registers a new key that getKey can resolve", async () => {
    const store = createInMemoryBYOKKeyStore();
    await store.putKey({
      tenantId: "tenant-a",
      provider: "anthropic",
      keyAlias: "prod-anthropic",
      encryptedKeyRef: "kms:abc",
    });

    const resolution = await store.getKey({
      tenantId: "tenant-a",
      provider: "anthropic",
    });
    expect(resolution.source).toBe("tenant");
    expect(resolution.decryptedKey).toBe("kms:abc");
    expect(resolution.provider).toBe("anthropic");
  });

  test("getKey returns source=missing when no key exists", async () => {
    const store = createInMemoryBYOKKeyStore();
    const resolution = await store.getKey({
      tenantId: "tenant-a",
      provider: "openai",
    });
    expect(resolution.source).toBe("missing");
    expect(resolution.decryptedKey).toBeNull();
  });

  test("revokeKey hides the key from getKey but listKeys still shows it", async () => {
    const store = createInMemoryBYOKKeyStore();
    await store.putKey({
      tenantId: "tenant-a",
      provider: "anthropic",
      keyAlias: "prod-anthropic",
      encryptedKeyRef: "kms:abc",
    });
    await store.revokeKey({ tenantId: "tenant-a", provider: "anthropic" });

    const resolution = await store.getKey({
      tenantId: "tenant-a",
      provider: "anthropic",
    });
    expect(resolution.source).toBe("missing");

    const list = await store.listKeys({ tenantId: "tenant-a" });
    expect(list).toHaveLength(1);
    expect(list[0]?.status).toBe("revoked");
  });

  test("revokeKey on a missing key is a no-op", async () => {
    const store = createInMemoryBYOKKeyStore();
    await store.revokeKey({ tenantId: "tenant-a", provider: "anthropic" });
    const list = await store.listKeys({ tenantId: "tenant-a" });
    expect(list).toHaveLength(0);
  });

  test("re-putting the same provider overwrites and revives the record", async () => {
    const store = createInMemoryBYOKKeyStore();
    await store.putKey({
      tenantId: "tenant-a",
      provider: "anthropic",
      keyAlias: "v1",
      encryptedKeyRef: "kms:old",
    });
    await store.revokeKey({ tenantId: "tenant-a", provider: "anthropic" });
    await store.putKey({
      tenantId: "tenant-a",
      provider: "anthropic",
      keyAlias: "v2",
      encryptedKeyRef: "kms:new",
    });

    const resolution = await store.getKey({
      tenantId: "tenant-a",
      provider: "anthropic",
    });
    expect(resolution.source).toBe("tenant");
    expect(resolution.decryptedKey).toBe("kms:new");

    const list = await store.listKeys({ tenantId: "tenant-a" });
    expect(list).toHaveLength(1);
    expect(list[0]?.keyAlias).toBe("v2");
    expect(list[0]?.status).toBe("active");
  });

  // ── Multi-tenant isolation ──────────────────────────────

  test("tenants cannot see each other's keys via getKey", async () => {
    const store = createInMemoryBYOKKeyStore();
    await store.putKey({
      tenantId: "tenant-a",
      provider: "anthropic",
      keyAlias: "a-key",
      encryptedKeyRef: "kms:a",
    });

    const otherTenant = await store.getKey({
      tenantId: "tenant-b",
      provider: "anthropic",
    });
    expect(otherTenant.source).toBe("missing");
  });

  test("listKeys only returns keys for the requested tenant", async () => {
    const store = createInMemoryBYOKKeyStore();
    await store.putKey({
      tenantId: "tenant-a",
      provider: "anthropic",
      keyAlias: "a-key",
      encryptedKeyRef: "kms:a",
    });
    await store.putKey({
      tenantId: "tenant-b",
      provider: "openai",
      keyAlias: "b-key",
      encryptedKeyRef: "kms:b",
    });

    const listA = await store.listKeys({ tenantId: "tenant-a" });
    expect(listA.map((k) => k.tenantId)).toEqual(["tenant-a"]);
    const listB = await store.listKeys({ tenantId: "tenant-b" });
    expect(listB.map((k) => k.tenantId)).toEqual(["tenant-b"]);
  });

  // ── Encrypted reference handling ────────────────────────

  test("encryptedKeyRef is treated as opaque (default resolver echoes it back)", async () => {
    const store = createInMemoryBYOKKeyStore();
    await store.putKey({
      tenantId: "tenant-a",
      provider: "anthropic",
      keyAlias: "alias",
      encryptedKeyRef: "ref-token",
    });
    const resolved = await store.getKey({
      tenantId: "tenant-a",
      provider: "anthropic",
    });
    expect(resolved.decryptedKey).toBe("ref-token");
  });

  test("custom resolveEncryptedKey hook is invoked for decryption", async () => {
    const store = createInMemoryBYOKKeyStore({
      resolveEncryptedKey: (ref) => `decrypted:${ref}`,
    });
    await store.putKey({
      tenantId: "tenant-a",
      provider: "anthropic",
      keyAlias: "alias",
      encryptedKeyRef: "opaque",
    });
    const resolved = await store.getKey({
      tenantId: "tenant-a",
      provider: "anthropic",
    });
    expect(resolved.decryptedKey).toBe("decrypted:opaque");
  });

  test("getKey updates lastUsedAt on successful resolve", async () => {
    const store = createInMemoryBYOKKeyStore();
    await store.putKey({
      tenantId: "tenant-a",
      provider: "anthropic",
      keyAlias: "alias",
      encryptedKeyRef: "ref",
    });
    const before = await store.listKeys({ tenantId: "tenant-a" });
    expect(before[0]?.lastUsedAt).toBeUndefined();
    await store.getKey({ tenantId: "tenant-a", provider: "anthropic" });
    const after = await store.listKeys({ tenantId: "tenant-a" });
    expect(after[0]?.lastUsedAt).toBeDefined();
  });

  // ── Input validation ────────────────────────────────────

  test("putKey rejects empty tenantId / provider / alias / ref", async () => {
    const store = createInMemoryBYOKKeyStore();
    await expect(
      store.putKey({ tenantId: "", provider: "p", keyAlias: "a", encryptedKeyRef: "r" }),
    ).rejects.toThrow(/tenantId/);
    await expect(
      store.putKey({ tenantId: "t", provider: "", keyAlias: "a", encryptedKeyRef: "r" }),
    ).rejects.toThrow(/provider/);
    await expect(
      store.putKey({ tenantId: "t", provider: "p", keyAlias: "", encryptedKeyRef: "r" }),
    ).rejects.toThrow(/keyAlias/);
    await expect(
      store.putKey({ tenantId: "t", provider: "p", keyAlias: "a", encryptedKeyRef: "" }),
    ).rejects.toThrow(/encryptedKeyRef/);
  });
});
