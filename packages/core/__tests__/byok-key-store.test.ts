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

  // ── Clock override determinism ──────────────────────────
  //
  // The `now` hook lets tests pin the wall clock so `createdAt` /
  // `lastUsedAt` are reproducible. These tests prove the hook is
  // honored on both code paths and that callers can advance time
  // step-by-step to assert ordering semantics.

  test("putKey uses the injected `now` for createdAt", async () => {
    const FIXED_MS = Date.UTC(2026, 4, 18, 12, 0, 0); // 2026-05-18T12:00:00Z
    const FIXED_ISO = new Date(FIXED_MS).toISOString();
    const store = createInMemoryBYOKKeyStore({ now: () => FIXED_MS });

    await store.putKey({
      tenantId: "tenant-a",
      provider: "anthropic",
      keyAlias: "alias",
      encryptedKeyRef: "ref",
    });

    const list = await store.listKeys({ tenantId: "tenant-a" });
    expect(list).toHaveLength(1);
    expect(list[0]?.createdAt).toBe(FIXED_ISO);
    // lastUsedAt is only set on getKey — must remain undefined.
    expect(list[0]?.lastUsedAt).toBeUndefined();
  });

  test("getKey uses the injected `now` for lastUsedAt and supports advancing time", async () => {
    let currentMs = Date.UTC(2026, 4, 18, 12, 0, 0); // 2026-05-18T12:00:00Z
    const store = createInMemoryBYOKKeyStore({ now: () => currentMs });

    await store.putKey({
      tenantId: "tenant-a",
      provider: "anthropic",
      keyAlias: "alias",
      encryptedKeyRef: "ref",
    });
    const createdAtIso = new Date(currentMs).toISOString();

    // Advance the clock by exactly one hour, then resolve the key.
    currentMs += 60 * 60 * 1000;
    const expectedUsedAtIso = new Date(currentMs).toISOString();
    await store.getKey({ tenantId: "tenant-a", provider: "anthropic" });

    const list = await store.listKeys({ tenantId: "tenant-a" });
    expect(list[0]?.createdAt).toBe(createdAtIso);
    expect(list[0]?.lastUsedAt).toBe(expectedUsedAtIso);

    // Advance again and confirm lastUsedAt moves forward — proves the
    // record reads `now()` on every resolve, not a captured value.
    currentMs += 30 * 60 * 1000;
    const secondUsedAtIso = new Date(currentMs).toISOString();
    await store.getKey({ tenantId: "tenant-a", provider: "anthropic" });
    const list2 = await store.listKeys({ tenantId: "tenant-a" });
    expect(list2[0]?.lastUsedAt).toBe(secondUsedAtIso);
  });

  test("re-putting an existing key preserves the original createdAt under a frozen clock", async () => {
    let currentMs = Date.UTC(2026, 4, 18, 9, 0, 0);
    const store = createInMemoryBYOKKeyStore({ now: () => currentMs });

    await store.putKey({
      tenantId: "tenant-a",
      provider: "anthropic",
      keyAlias: "v1",
      encryptedKeyRef: "kms:old",
    });
    const originalCreatedAt = new Date(currentMs).toISOString();

    // Advance the clock and overwrite — createdAt MUST stay pinned to
    // the original moment, not move forward with `now`.
    currentMs += 60 * 60 * 1000;
    await store.putKey({
      tenantId: "tenant-a",
      provider: "anthropic",
      keyAlias: "v2",
      encryptedKeyRef: "kms:new",
    });

    const list = await store.listKeys({ tenantId: "tenant-a" });
    expect(list).toHaveLength(1);
    expect(list[0]?.createdAt).toBe(originalCreatedAt);
    expect(list[0]?.keyAlias).toBe("v2");
  });
});
