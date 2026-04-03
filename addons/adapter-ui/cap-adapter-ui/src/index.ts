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
export type { SupportedLanguage } from "./i18n";
// i18n
export { changeLanguage, default as i18n, languageNames, supportedLanguages } from "./i18n";
export { resolveEntityLabel, useSchemaLabel } from "./i18n/use-entity-label";
// Layout components
export { ShellLayout } from "./layouts/shell";
// Page components
export { EntityFormPage } from "./pages/entity-form";
export { EntityListPage } from "./pages/entity-list";
export { WorkspacePage } from "./pages/workspace";

// Admin route registry
export { registerAdminRoute, getAdminRoutes } from "./lib/route-registry";
export type { AdminRouteRegistration } from "./lib/route-registry";
export { AdminLayout } from "./pages/admin-layout";
