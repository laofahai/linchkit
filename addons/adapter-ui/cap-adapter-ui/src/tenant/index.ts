/**
 * Tenant self-service surface — public exports.
 *
 * Re-exports all components, types, helpers, and the hook so consumers
 * can import everything from `@linchkit/cap-adapter-ui/tenant` (or via
 * the package root once added to `src/index.ts`).
 */

export type { TenantBrandingFormProps } from "./tenant-branding-form";
export { TenantBrandingForm } from "./tenant-branding-form";
export type { TenantConfigEditorProps } from "./tenant-config-editor";
export { TenantConfigEditor } from "./tenant-config-editor";
export {
  formatBytes,
  formatUsageRatio,
  INVITABLE_ROLES,
  isInvitableRole,
  isValidEmail,
  isValidHexColor,
} from "./tenant-helpers";
export type { TenantMembersTableProps } from "./tenant-members-table";
export { TenantMembersTable } from "./tenant-members-table";
export type {
  InviteMemberInput,
  TenantBranding,
  TenantConfig,
  TenantInvitationStatus,
  TenantMember,
  TenantMemberRole,
  TenantSelfServiceSnapshot,
  TenantUsageStats,
} from "./tenant-self-service-types";
export { TenantSettingsPage } from "./tenant-settings-page";
export type { TenantUsageDashboardProps } from "./tenant-usage-dashboard";
export { TenantUsageDashboard } from "./tenant-usage-dashboard";
export type { UseTenantSelfServiceResult } from "./use-tenant-self-service";
export { useTenantSelfService } from "./use-tenant-self-service";
