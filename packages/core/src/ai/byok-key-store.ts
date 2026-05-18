/**
 * BYOK Key Store
 *
 * Pluggable storage interface for per-tenant AI API keys. Plaintext
 * keys are never stored or returned — callers persist only the opaque
 * `encryptedKeyRef` produced by their KMS / secret manager.
 *
 * The in-memory implementation is intended for tests and dev. Real
 * deployments wire a Drizzle-backed implementation in the adapter
 * layer (out of scope for this module — Spec 36 M2+).
 */

import type { BYOKKeyRecord, BYOKKeyResolution } from "./byok-types";

// ── Interface ───────────────────────────────────────────────

/** Parameters for {@link BYOKKeyStore.getKey}. */
export interface GetKeyParams {
  tenantId: string;
  provider: string;
}

/** Parameters for {@link BYOKKeyStore.putKey}. */
export interface PutKeyParams {
  tenantId: string;
  provider: string;
  keyAlias: string;
  encryptedKeyRef: string;
}

/** Parameters for {@link BYOKKeyStore.revokeKey}. */
export interface RevokeKeyParams {
  tenantId: string;
  provider: string;
}

/** Parameters for {@link BYOKKeyStore.listKeys}. */
export interface ListKeysParams {
  tenantId: string;
}

/**
 * Storage contract for per-tenant BYOK keys.
 *
 * Implementations are responsible for tenant isolation — callers
 * always supply `tenantId` and the store must never leak records
 * across tenants. The interface returns a {@link BYOKKeyResolution}
 * rather than the raw record so the resolver layer can swap in a
 * platform-default key when the tenant has none.
 */
export interface BYOKKeyStore {
  /**
   * Look up the active key for `(tenantId, provider)`.
   *
   * Returns `source: "tenant"` with a non-null `decryptedKey` when an
   * active key exists, otherwise `source: "missing"` with a `null`
   * key. The resolver — not the store — is responsible for falling
   * back to a platform default; the store reports only what it owns.
   */
  getKey(params: GetKeyParams): Promise<BYOKKeyResolution>;

  /**
   * Register or overwrite a key for `(tenantId, provider)`. Re-using
   * the same provider replaces the prior record (and revives a
   * previously revoked entry). `encryptedKeyRef` is opaque to the
   * store — the KMS / secret manager owns the plaintext mapping.
   */
  putKey(params: PutKeyParams): Promise<void>;

  /**
   * Mark the active key for `(tenantId, provider)` as revoked.
   * Idempotent: revoking a missing or already-revoked key is a no-op.
   * Revoked records are retained so the listing surface (and audit)
   * can show their history.
   */
  revokeKey(params: RevokeKeyParams): Promise<void>;

  /**
   * Enumerate all keys (active and revoked) for one tenant.
   * Plaintext keys are NEVER returned — only metadata records.
   */
  listKeys(params: ListKeysParams): Promise<BYOKKeyRecord[]>;
}

// ── In-Memory Implementation ────────────────────────────────

/**
 * In-memory implementation of {@link BYOKKeyStore}.
 *
 * Backed by a Map keyed by `tenantId\0provider` so tenants share no
 * state. Suitable for tests, demos, and dev runs — production code
 * should plug in a persistent store via the same interface.
 *
 * The "decryption" here is a placeholder: it simply echoes the
 * `encryptedKeyRef` back as the decrypted value. Real implementations
 * must replace this with a KMS dereference. The factory accepts an
 * optional `resolveEncryptedKey` callback so deployments can inject
 * the real decryption pathway without rewriting the store.
 */
export interface InMemoryBYOKKeyStoreOptions {
  /**
   * Hook that turns an opaque `encryptedKeyRef` into the plaintext
   * key the AI provider expects. Defaults to identity for tests.
   * The hook receives only the reference — never the plaintext — so
   * it can dispatch to a KMS without leaking secrets through logs.
   */
  resolveEncryptedKey?: (encryptedKeyRef: string) => Promise<string> | string;
}

export function createInMemoryBYOKKeyStore(options?: InMemoryBYOKKeyStoreOptions): BYOKKeyStore {
  // Key shape: `${tenantId}\0${provider}`. Using NUL avoids ambiguity
  // when tenant/provider ids contain ":" or "/" characters.
  const records: Map<string, BYOKKeyRecord> = new Map();
  const resolveEncryptedKey = options?.resolveEncryptedKey ?? ((ref: string) => ref);

  function buildKey(tenantId: string, provider: string): string {
    return `${tenantId}\0${provider}`;
  }

  return {
    async getKey({ tenantId, provider }) {
      assertNonEmpty(tenantId, "tenantId");
      assertNonEmpty(provider, "provider");

      const record = records.get(buildKey(tenantId, provider));
      if (!record || record.status !== "active") {
        return { provider, decryptedKey: null, source: "missing" };
      }
      const decryptedKey = await resolveEncryptedKey(record.encryptedKeyRef);
      // Update lastUsedAt on successful resolve — this is the closest
      // moment we know the key was actually used. Mutating the record
      // is safe because the Map holds the same reference.
      record.lastUsedAt = new Date().toISOString();
      return { provider, decryptedKey, source: "tenant" };
    },

    async putKey({ tenantId, provider, keyAlias, encryptedKeyRef }) {
      assertNonEmpty(tenantId, "tenantId");
      assertNonEmpty(provider, "provider");
      assertNonEmpty(keyAlias, "keyAlias");
      assertNonEmpty(encryptedKeyRef, "encryptedKeyRef");

      const key = buildKey(tenantId, provider);
      const existing = records.get(key);
      const createdAt = existing?.createdAt ?? new Date().toISOString();
      records.set(key, {
        tenantId,
        provider,
        keyAlias,
        encryptedKeyRef,
        status: "active",
        createdAt,
      });
    },

    async revokeKey({ tenantId, provider }) {
      assertNonEmpty(tenantId, "tenantId");
      assertNonEmpty(provider, "provider");

      const key = buildKey(tenantId, provider);
      const existing = records.get(key);
      if (!existing) return;
      records.set(key, { ...existing, status: "revoked" });
    },

    async listKeys({ tenantId }) {
      assertNonEmpty(tenantId, "tenantId");
      const out: BYOKKeyRecord[] = [];
      for (const record of records.values()) {
        if (record.tenantId === tenantId) out.push({ ...record });
      }
      // Stable order: newest first by createdAt. Falls back to alias
      // on tie so the listing is deterministic in tests.
      out.sort((a, b) => {
        if (a.createdAt !== b.createdAt) {
          return a.createdAt < b.createdAt ? 1 : -1;
        }
        return a.keyAlias.localeCompare(b.keyAlias);
      });
      return out;
    },
  };
}

// ── Internal helpers ────────────────────────────────────────

function assertNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`BYOKKeyStore: ${name} must be a non-empty string`);
  }
}
