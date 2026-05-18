/**
 * TenantSettingsPage — top-level page that mounts the four self-service
 * tabs (Branding | Config | Members | Usage) and wires them to the
 * shared `useTenantSelfService()` hook.
 *
 * Status: PREVIEW — the underlying hook is mock-backed. See
 * `use-tenant-self-service.ts` for the wiring TODO.
 */

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@linchkit/ui-kit/components";
import { useTranslation } from "react-i18next";
import { TenantBrandingForm } from "./tenant-branding-form";
import { TenantConfigEditor } from "./tenant-config-editor";
import { TenantMembersTable } from "./tenant-members-table";
import { TenantUsageDashboard } from "./tenant-usage-dashboard";
import { useTenantSelfService } from "./use-tenant-self-service";

export function TenantSettingsPage() {
  const { t } = useTranslation();
  const { loading, error, snapshot, saveBranding, saveConfig, inviteMember, removeMember } =
    useTenantSelfService();

  if (error) {
    return (
      <div className="p-6">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }

  if (loading || !snapshot) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">
          {t("tenant.loading", "Loading tenant settings...")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">{snapshot.branding.appName}</h1>
        <p className="text-sm text-muted-foreground">
          {t(
            "tenant.page.subtitle",
            "Manage your tenant's branding, configuration, members, and usage.",
          )}
        </p>
      </header>

      <Tabs defaultValue="branding" className="w-full">
        <TabsList>
          <TabsTrigger value="branding">{t("tenant.tabs.branding", "Branding")}</TabsTrigger>
          <TabsTrigger value="config">{t("tenant.tabs.config", "Configuration")}</TabsTrigger>
          <TabsTrigger value="members">{t("tenant.tabs.members", "Members")}</TabsTrigger>
          <TabsTrigger value="usage">{t("tenant.tabs.usage", "Usage")}</TabsTrigger>
        </TabsList>

        <TabsContent value="branding" className="mt-4">
          <TenantBrandingForm value={snapshot.branding} onSave={saveBranding} />
        </TabsContent>

        <TabsContent value="config" className="mt-4">
          <TenantConfigEditor value={snapshot.config} onSave={saveConfig} />
        </TabsContent>

        <TabsContent value="members" className="mt-4">
          <TenantMembersTable
            members={snapshot.members}
            onInvite={inviteMember}
            onRemove={removeMember}
          />
        </TabsContent>

        <TabsContent value="usage" className="mt-4">
          <TenantUsageDashboard usage={snapshot.usage} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
