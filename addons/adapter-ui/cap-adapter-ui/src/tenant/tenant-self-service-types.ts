/**
 * Tenant self-service domain types.
 *
 * Shared between page, sub-components, and the (mock) hook.
 * Real types should later be derived from the GraphQL schema or
 * `defineEntity('tenant')` so they stay in sync with the backend.
 */

/** Roles a tenant member can be assigned. Keep in sync with cap-permission. */
export type TenantMemberRole = "owner" | "admin" | "member" | "viewer";

/** Status of an invitation lifecycle. */
export type TenantInvitationStatus = "pending" | "accepted" | "expired" | "revoked";

/**
 * Visual identity for a tenant.
 *
 * `primaryColor` is a CSS color string (hex preferred). `logoUrl`
 * may be empty while the tenant has no logo configured.
 */
export interface TenantBranding {
  appName: string;
  logoUrl: string;
  primaryColor: string;
}

/**
 * Tenant-level configuration knobs.
 *
 * `features` is a free-form KV map of feature toggles
 * (boolean / string / number). `defaultLocale` is the BCP-47 tag
 * used as fallback when a user has not picked their own locale.
 */
export interface TenantConfig {
  defaultLocale: string;
  features: Record<string, boolean | string | number>;
}

/** A single member of the current tenant. */
export interface TenantMember {
  id: string;
  email: string;
  displayName: string;
  role: TenantMemberRole;
  joinedAt: string;
  status: "active" | "invited" | "suspended";
}

/** Read-only usage metrics shown in the dashboard tab. */
export interface TenantUsageStats {
  periodStart: string;
  periodEnd: string;
  requests: { used: number; limit: number };
  storageBytes: { used: number; limit: number };
  aiTokens: { used: number; limit: number };
}

/** Aggregate snapshot returned by the self-service hook. */
export interface TenantSelfServiceSnapshot {
  branding: TenantBranding;
  config: TenantConfig;
  members: TenantMember[];
  usage: TenantUsageStats;
}

/** Payload for inviting a new member. */
export interface InviteMemberInput {
  email: string;
  role: TenantMemberRole;
}
