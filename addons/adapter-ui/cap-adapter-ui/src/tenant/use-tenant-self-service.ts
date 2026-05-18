/**
 * useTenantSelfService — central hook for the tenant settings page.
 *
 * Returns a snapshot of branding / config / members / usage plus mutation
 * helpers (saveBranding, saveConfig, inviteMember, removeMember).
 *
 * Status: PREVIEW. Data is mocked locally so the UI renders without a
 * live backend. Mutations only update local state.
 *
 * TODO: wire to GraphQL (read) + Actions (write) — track in issue #133
 *       follow-up. Expected wiring:
 *         - reads → `query tenant { branding, config, members, usage }`
 *         - writes → executeAction('update_tenant_branding'),
 *                    executeAction('update_tenant_config'),
 *                    executeAction('invite_tenant_member'),
 *                    executeAction('remove_tenant_member')
 */

import { useCallback, useEffect, useState } from "react";
import type {
  InviteMemberInput,
  TenantBranding,
  TenantConfig,
  TenantMember,
  TenantSelfServiceSnapshot,
  TenantUsageStats,
} from "./tenant-self-service-types";

// ── Mock snapshot ────────────────────────────────────────

const MOCK_BRANDING: TenantBranding = {
  appName: "Acme Workspace",
  logoUrl: "",
  primaryColor: "#2563eb",
};

const MOCK_CONFIG: TenantConfig = {
  defaultLocale: "en",
  features: {
    enableAiAssistant: true,
    enableAdvancedReports: false,
    aiTokenBudget: 1_000_000,
  },
};

const MOCK_MEMBERS: TenantMember[] = [
  {
    id: "u_owner",
    email: "owner@example.com",
    displayName: "Tenant Owner",
    role: "owner",
    joinedAt: "2026-01-01T00:00:00.000Z",
    status: "active",
  },
  {
    id: "u_admin",
    email: "admin@example.com",
    displayName: "Admin User",
    role: "admin",
    joinedAt: "2026-02-12T00:00:00.000Z",
    status: "active",
  },
  {
    id: "u_member",
    email: "alex@example.com",
    displayName: "Alex Member",
    role: "member",
    joinedAt: "2026-03-04T00:00:00.000Z",
    status: "active",
  },
];

const MOCK_USAGE: TenantUsageStats = {
  periodStart: "2026-05-01T00:00:00.000Z",
  periodEnd: "2026-05-31T23:59:59.000Z",
  requests: { used: 42_318, limit: 100_000 },
  storageBytes: { used: 7.4 * 1024 ** 3, limit: 25 * 1024 ** 3 },
  aiTokens: { used: 312_450, limit: MOCK_CONFIG.features.aiTokenBudget as number },
};

const MOCK_SNAPSHOT: TenantSelfServiceSnapshot = {
  branding: MOCK_BRANDING,
  config: MOCK_CONFIG,
  members: MOCK_MEMBERS,
  usage: MOCK_USAGE,
};

// ── Hook surface ─────────────────────────────────────────

export interface UseTenantSelfServiceResult {
  loading: boolean;
  error: string | null;
  snapshot: TenantSelfServiceSnapshot | null;
  refresh: () => Promise<void>;
  saveBranding: (next: TenantBranding) => Promise<void>;
  saveConfig: (next: TenantConfig) => Promise<void>;
  inviteMember: (input: InviteMemberInput) => Promise<void>;
  removeMember: (memberId: string) => Promise<void>;
}

/**
 * Centralised access to the tenant self-service state. Today returns
 * mock data; see file-level TODO for the planned GraphQL/Action wiring.
 */
export function useTenantSelfService(): UseTenantSelfServiceResult {
  const [snapshot, setSnapshot] = useState<TenantSelfServiceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    // TODO: wire to GraphQL — for now resolve synchronously with the mock.
    await Promise.resolve();
    // Deep-ish clone so callers can mutate without poisoning the constant.
    setSnapshot({
      branding: { ...MOCK_SNAPSHOT.branding },
      config: { ...MOCK_SNAPSHOT.config, features: { ...MOCK_SNAPSHOT.config.features } },
      members: MOCK_SNAPSHOT.members.map((m) => ({ ...m })),
      usage: {
        ...MOCK_SNAPSHOT.usage,
        requests: { ...MOCK_SNAPSHOT.usage.requests },
        storageBytes: { ...MOCK_SNAPSHOT.usage.storageBytes },
        aiTokens: { ...MOCK_SNAPSHOT.usage.aiTokens },
      },
    });
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveBranding = useCallback(async (next: TenantBranding) => {
    // TODO: wire to Action `update_tenant_branding`.
    await Promise.resolve();
    setSnapshot((prev) => (prev ? { ...prev, branding: { ...next } } : prev));
  }, []);

  const saveConfig = useCallback(async (next: TenantConfig) => {
    // TODO: wire to Action `update_tenant_config`.
    await Promise.resolve();
    setSnapshot((prev) =>
      prev ? { ...prev, config: { ...next, features: { ...next.features } } } : prev,
    );
  }, []);

  const inviteMember = useCallback(async ({ email, role }: InviteMemberInput) => {
    // TODO: wire to Action `invite_tenant_member`.
    await Promise.resolve();
    setSnapshot((prev) => {
      if (!prev) return prev;
      const newMember: TenantMember = {
        id: `invite_${Date.now()}`,
        email,
        displayName: email.split("@")[0] ?? email,
        role,
        joinedAt: new Date().toISOString(),
        status: "invited",
      };
      return { ...prev, members: [...prev.members, newMember] };
    });
  }, []);

  const removeMember = useCallback(async (memberId: string) => {
    // TODO: wire to Action `remove_tenant_member`.
    await Promise.resolve();
    setSnapshot((prev) =>
      prev ? { ...prev, members: prev.members.filter((m) => m.id !== memberId) } : prev,
    );
  }, []);

  return {
    loading,
    error,
    snapshot,
    refresh,
    saveBranding,
    saveConfig,
    inviteMember,
    removeMember,
  };
}
