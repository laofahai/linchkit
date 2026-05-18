/**
 * BYOK Key Resolver
 *
 * Pure function that determines which AI API key to use for a given
 * `(tenantId, provider)` request. Resolution order:
 *
 *   1. Tenant override — `byokStore.getKey()` returns an active key
 *   2. Platform default — caller-supplied fallback for the provider
 *   3. Missing — no key available; caller must fail closed
 *
 * Kept separate from {@link BYOKKeyStore} so the store stays a
 * single-tenant lookup and the resolver owns the cross-layer policy.
 */

import type { BYOKKeyStore } from "./byok-key-store";
import type { BYOKKeyResolution } from "./byok-types";

/** Parameters for {@link resolveAIKey}. */
export interface ResolveAIKeyParams {
  /** Owning tenant. Required — there is no anonymous BYOK lookup. */
  tenantId: string;

  /** AI provider id (e.g. "anthropic"). */
  provider: string;

  /** Store to consult for tenant-level overrides. */
  byokStore: BYOKKeyStore;

  /**
   * Platform-provided fallback key for this provider. Pass the
   * decrypted plaintext (or KMS-dereferenced value) — the resolver
   * does NOT decrypt it. Omit / pass `null` if the platform has no
   * default for this provider.
   */
  platformDefault?: string | null;
}

/**
 * Resolve an AI key. Returns a {@link BYOKKeyResolution} whose
 * `source` field indicates which layer satisfied the lookup. When
 * neither tenant nor platform has a key, returns `source: "missing"`
 * with `decryptedKey === null`.
 */
export async function resolveAIKey(params: ResolveAIKeyParams): Promise<BYOKKeyResolution> {
  const { tenantId, provider, byokStore, platformDefault } = params;

  if (typeof tenantId !== "string" || tenantId.length === 0) {
    throw new Error("resolveAIKey: tenantId must be a non-empty string");
  }
  if (typeof provider !== "string" || provider.length === 0) {
    throw new Error("resolveAIKey: provider must be a non-empty string");
  }

  // 1. Tenant override — store reports "tenant" or "missing".
  const tenantResolution = await byokStore.getKey({ tenantId, provider });
  if (tenantResolution.source === "tenant" && tenantResolution.decryptedKey) {
    return tenantResolution;
  }

  // 2. Platform default. Treat empty string the same as null so a
  //    misconfigured env var doesn't silently authenticate as the
  //    platform identity with no credential.
  if (platformDefault && platformDefault.length > 0) {
    return {
      provider,
      decryptedKey: platformDefault,
      source: "platform",
    };
  }

  // 3. Missing — explicit signal so the caller fails closed.
  return { provider, decryptedKey: null, source: "missing" };
}
