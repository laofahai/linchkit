/**
 * @linchkit/cap-adapter-ui — Frontend UI components + Headless hooks
 *
 * Shadcn + React + TanStack Router/Query/Table
 */

export const VERSION = "0.0.1";

export { useTheme } from "@linchkit/ui-kit/hooks";
// Utilities
export { cn } from "@linchkit/ui-kit/lib/utils";
// Capability definition
export { capAdapterUi } from "./capability";
// UI components
export { AppSidebar } from "./components/app-sidebar";
export type { AutoFormProps } from "./components/auto-form";
export { AutoForm } from "./components/auto-form";
export type {
  AutoListProps,
  AutoListViewDefinition,
  ViewFilter,
  ViewFilterType,
} from "./components/auto-list";
export { AutoList } from "./components/auto-list";
export { FieldDisplay, FieldInput } from "./components/field-renderer";
export { LanguageSwitcher } from "./components/language-switcher";
export { ThemeToggle } from "./components/theme-toggle";
// Config schema
export { capAdapterUiConfig } from "./config";
// Hooks
export { useBreadcrumb } from "./hooks/use-breadcrumb";
export { BreadcrumbTitleProvider, useBreadcrumbTitle } from "./hooks/use-breadcrumb-title";
export type {
  UseEntityOnchangeOptions,
  UseEntityOnchangeReturn,
} from "./hooks/use-entity-onchange";
export {
  DEFAULT_ONCHANGE_DEBOUNCE_MS,
  useEntityOnchange,
} from "./hooks/use-entity-onchange";
// Field-lock bypass + unlock (Spec 63 §5.2)
export type { FieldUnlockState } from "./hooks/use-field-lock-bypass";
export { useFieldLockBypass, useFieldUnlock } from "./hooks/use-field-lock-bypass";
export type { FieldLockStateMap, UseFieldLockStateArgs } from "./hooks/use-field-lock-state";
// Field-lock state (Spec 63 §5.1)
export { useFieldLockState } from "./hooks/use-field-lock-state";
export type { SupportedLanguage } from "./i18n";
// i18n
export { changeLanguage, default as i18n, languageNames, supportedLanguages } from "./i18n";
export { resolveEntityLabel, useEntityLabel, useSchemaLabel } from "./i18n/use-entity-label";
// Layout components
export { ShellLayout } from "./layouts/shell";
export type { EntityOnchangeResult } from "./lib/api";
export { requestEntityOnchange } from "./lib/api";
export type {
  ComputeEntityLockStateArgs,
  ComputeFieldLockStateArgs,
  FieldLockReason,
  FieldLockState,
} from "./lib/field-lock-state";
export {
  computeEntityLockState,
  computeFieldLockState,
  matchesLockCondition,
} from "./lib/field-lock-state";
// Onchange dispatcher (framework-agnostic primitives — useful for non-React hosts)
export type { OnchangeFetcher } from "./lib/onchange-dispatcher";
export { buildOnchangeIndex, OnchangeDispatcher } from "./lib/onchange-dispatcher";
export type { AdminRouteRegistration } from "./lib/route-registry";
// Admin route registry
export { getAdminRoutes, registerAdminRoute } from "./lib/route-registry";
export { AdminLayout } from "./pages/admin-layout";
// Page components
export { EntityFormPage } from "./pages/entity-form";
export { EntityListPage } from "./pages/entity-list";
export { WorkspacePage } from "./pages/workspace";

// Tenant self-service surface (Spec 30 M2+, issue #133)
export * from "./tenant";
