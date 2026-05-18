import { describe, expect, test } from "bun:test";
import { createInMemoryBYOKKeyStore } from "../src/ai/byok-key-store";
import { resolveAIKey } from "../src/ai/byok-resolver";

describe("resolveAIKey", () => {
  // ── Resolution order ───────────────────────────────────────

  test("tenant key resolves over platform default", async () => {
    const store = createInMemoryBYOKKeyStore();
    await store.putKey({
      tenantId: "tenant-a",
      provider: "anthropic",
      keyAlias: "tenant-key",
      encryptedKeyRef: "kms:tenant",
    });

    const resolution = await resolveAIKey({
      tenantId: "tenant-a",
      provider: "anthropic",
      byokStore: store,
      platformDefault: "platform-key",
    });

    expect(resolution.source).toBe("tenant");
    expect(resolution.decryptedKey).toBe("kms:tenant");
    expect(resolution.provider).toBe("anthropic");
  });

  test("platform default used when no tenant key", async () => {
    const store = createInMemoryBYOKKeyStore();

    const resolution = await resolveAIKey({
      tenantId: "tenant-a",
      provider: "openai",
      byokStore: store,
      platformDefault: "sk-platform",
    });

    expect(resolution.source).toBe("platform");
    expect(resolution.decryptedKey).toBe("sk-platform");
    expect(resolution.provider).toBe("openai");
  });

  test("returns missing when neither tenant nor platform has a key", async () => {
    const store = createInMemoryBYOKKeyStore();

    const resolution = await resolveAIKey({
      tenantId: "tenant-a",
      provider: "anthropic",
      byokStore: store,
    });

    expect(resolution.source).toBe("missing");
    expect(resolution.decryptedKey).toBeNull();
    expect(resolution.provider).toBe("anthropic");
  });

  test("revoked tenant key falls through to platform default", async () => {
    const store = createInMemoryBYOKKeyStore();
    await store.putKey({
      tenantId: "tenant-a",
      provider: "anthropic",
      keyAlias: "tenant-key",
      encryptedKeyRef: "kms:tenant",
    });
    await store.revokeKey({ tenantId: "tenant-a", provider: "anthropic" });

    const resolution = await resolveAIKey({
      tenantId: "tenant-a",
      provider: "anthropic",
      byokStore: store,
      platformDefault: "platform-key",
    });

    expect(resolution.source).toBe("platform");
    expect(resolution.decryptedKey).toBe("platform-key");
  });

  // ── Provider isolation ─────────────────────────────────────

  test("multi-provider isolation: openai key does not satisfy anthropic lookup", async () => {
    const store = createInMemoryBYOKKeyStore();
    await store.putKey({
      tenantId: "tenant-a",
      provider: "openai",
      keyAlias: "openai-key",
      encryptedKeyRef: "kms:openai",
    });

    const openaiResolution = await resolveAIKey({
      tenantId: "tenant-a",
      provider: "openai",
      byokStore: store,
    });
    expect(openaiResolution.source).toBe("tenant");
    expect(openaiResolution.decryptedKey).toBe("kms:openai");

    const anthropicResolution = await resolveAIKey({
      tenantId: "tenant-a",
      provider: "anthropic",
      byokStore: store,
    });
    expect(anthropicResolution.source).toBe("missing");
    expect(anthropicResolution.decryptedKey).toBeNull();
  });

  // ── Tenant isolation ───────────────────────────────────────

  test("tenant_id isolation: tenant-A key not visible to tenant-B", async () => {
    const store = createInMemoryBYOKKeyStore();
    await store.putKey({
      tenantId: "tenant-a",
      provider: "anthropic",
      keyAlias: "a-key",
      encryptedKeyRef: "kms:a",
    });

    const resolutionA = await resolveAIKey({
      tenantId: "tenant-a",
      provider: "anthropic",
      byokStore: store,
    });
    expect(resolutionA.source).toBe("tenant");
    expect(resolutionA.decryptedKey).toBe("kms:a");

    const resolutionB = await resolveAIKey({
      tenantId: "tenant-b",
      provider: "anthropic",
      byokStore: store,
    });
    expect(resolutionB.source).toBe("missing");
    expect(resolutionB.decryptedKey).toBeNull();
  });

  // ── Edge cases ─────────────────────────────────────────────

  test("empty-string platformDefault is treated as missing (does not authenticate as platform)", async () => {
    const store = createInMemoryBYOKKeyStore();

    const resolution = await resolveAIKey({
      tenantId: "tenant-a",
      provider: "anthropic",
      byokStore: store,
      platformDefault: "",
    });

    expect(resolution.source).toBe("missing");
    expect(resolution.decryptedKey).toBeNull();
  });

  test("null / undefined platformDefault behave identically", async () => {
    const store = createInMemoryBYOKKeyStore();

    const nullResolution = await resolveAIKey({
      tenantId: "tenant-a",
      provider: "anthropic",
      byokStore: store,
      platformDefault: null,
    });
    expect(nullResolution.source).toBe("missing");
    expect(nullResolution.decryptedKey).toBeNull();

    const undefinedResolution = await resolveAIKey({
      tenantId: "tenant-a",
      provider: "anthropic",
      byokStore: store,
    });
    expect(undefinedResolution.source).toBe("missing");
    expect(undefinedResolution.decryptedKey).toBeNull();
  });

  test("rejects empty tenantId and empty provider", async () => {
    const store = createInMemoryBYOKKeyStore();

    await expect(
      resolveAIKey({
        tenantId: "",
        provider: "anthropic",
        byokStore: store,
      }),
    ).rejects.toThrow(/tenantId/);

    await expect(
      resolveAIKey({
        tenantId: "tenant-a",
        provider: "",
        byokStore: store,
      }),
    ).rejects.toThrow(/provider/);
  });
});
