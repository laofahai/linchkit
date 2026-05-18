/**
 * BYOK (Bring Your Own Key) and AI Usage Control — Types
 *
 * Pure, runtime-agnostic types for per-tenant AI key management and
 * usage metering (Spec 36 M2+). Plaintext keys are NEVER stored in
 * memory or on disk — callers store an opaque `encryptedKeyRef` that
 * points at a KMS-managed secret.
 *
 * Field naming follows the existing TypeScript convention in this
 * package (camelCase). The underlying persisted entity (when promoted
 * to a Drizzle table) is expected to use snake_case columns
 * (`tenant_id`, `key_alias`, etc.) — those mappings live in the
 * adapter, not here.
 */

/**
 * A single BYOK key descriptor for one (tenant, provider) pair.
 *
 * Only `encryptedKeyRef` is persisted — the plaintext key never lives
 * in this object. `lastUsedAt` is optional so freshly-issued keys can
 * be represented before they're exercised.
 */
export interface BYOKKeyRecord {
  /** Owning tenant. Required: BYOK is per-tenant by definition. */
  tenantId: string;

  /** AI provider id (e.g. "anthropic", "openai", "google"). */
  provider: string;

  /** Human-readable alias used in UI / audit (e.g. "prod-anthropic"). */
  keyAlias: string;

  /**
   * Opaque reference to the encrypted key in a KMS / secret manager.
   * Treat as a string identifier — this module never dereferences it.
   */
  encryptedKeyRef: string;

  /** Lifecycle status. Revoked keys are kept for audit, not used. */
  status: "active" | "revoked";

  /** ISO-8601 timestamp when this key was registered. */
  createdAt: string;

  /** ISO-8601 timestamp of the most recent successful use, if any. */
  lastUsedAt?: string;
}

/**
 * Outcome of resolving an AI key for one (tenant, provider) request.
 *
 * `source` records the resolution path so callers can attribute cost
 * and surface it in audit logs:
 *   - `tenant`   — tenant has registered a BYOK key (overrides platform)
 *   - `platform` — fell back to the platform-provided default key
 *   - `missing`  — no key found at any layer; caller must fail closed
 *
 * `decryptedKey` is `null` whenever `source === "missing"`. When set,
 * the string is the plaintext key (or KMS-decrypted payload) the
 * caller should pass to the AI provider SDK. Callers MUST NOT log it.
 */
export interface BYOKKeyResolution {
  /** AI provider id that was resolved. */
  provider: string;

  /** Plaintext (or freshly decrypted) key — `null` when missing. */
  decryptedKey: string | null;

  /** Which layer satisfied the lookup. */
  source: "tenant" | "platform" | "missing";
}

/**
 * Per-tenant quota policy enforced by {@link UsageMeter.checkQuota}.
 *
 * All limits are per UTC calendar day. `softWarnThreshold` is a
 * fraction in (0, 1) at which a caller should surface a warning
 * before the hard limit is reached — quotas are still allowed past
 * the soft threshold.
 */
export interface UsageQuotaPolicy {
  /** Maximum total tokens (input + output) per UTC day. */
  maxTokensPerDay: number;

  /** Maximum estimated cost (USD) per UTC day. */
  maxCostUsdPerDay: number;

  /**
   * Soft warning threshold expressed as a fraction of the daily limit
   * (e.g. `0.8` warns at 80% consumption). Optional; when omitted no
   * warning state is computed.
   */
  softWarnThreshold?: number;
}

/**
 * A single metered usage record. One entry per completed AI call.
 *
 * `ts` is the wall-clock timestamp of the call as an ISO-8601 string.
 * The meter buckets by UTC calendar day (00:00:00Z → 23:59:59.999Z).
 */
export interface UsageMeterEntry {
  /** Tenant that made the call. */
  tenantId: string;

  /** AI provider id (e.g. "anthropic"). */
  provider: string;

  /** Concrete model identifier returned by the provider. */
  model: string;

  /** Tokens consumed by the prompt. */
  inputTokens: number;

  /** Tokens emitted by the response. */
  outputTokens: number;

  /** Estimated cost of the call in USD. */
  costUsd: number;

  /** Wall-clock timestamp of the call (ISO-8601). */
  ts: string;
}

/**
 * Result of a pre-call quota check. `allowed` is the only mandatory
 * field downstream code needs; the rest are for UX / observability.
 *
 * `remainingTokens` and `remainingCostUsd` can be negative when the
 * projected total already exceeds the policy — callers should treat
 * negative values as zero for display purposes but trust `allowed`
 * for enforcement.
 */
export interface QuotaCheckResult {
  /** True when the projected call fits inside the policy. */
  allowed: boolean;

  /**
   * Machine-readable reason when blocked or warned. One of:
   *   - "ok"            — within all limits
   *   - "soft_warning"  — past `softWarnThreshold`, still allowed
   *   - "token_limit"   — would exceed `maxTokensPerDay`
   *   - "cost_limit"    — would exceed `maxCostUsdPerDay`
   */
  reason: "ok" | "soft_warning" | "token_limit" | "cost_limit";

  /** Tokens left in today's budget BEFORE this call. */
  remainingTokens: number;

  /** USD left in today's budget BEFORE this call. */
  remainingCostUsd: number;
}
