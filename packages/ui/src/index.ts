/**
 * @linchkit/ui — Frontend UI components + Headless hooks
 *
 * Shadcn + React + TanStack Router/Query/Table
 */

export const VERSION = "0.0.1";

// UI components
export { AppSidebar } from "./components/app-sidebar";
export { AutoForm } from "./components/auto-form";
export type { AutoFormProps } from "./components/auto-form";
export { AutoList } from "./components/auto-list";
export type { AutoListProps, AutoListViewDefinition, ViewFilter, ViewFilterType } from "./components/auto-list";
export { FieldDisplay, FieldInput } from "./components/field-renderer";
export { ThemeToggle } from "./components/theme-toggle";
// Layout components
export { ShellLayout } from "./layouts/shell";
// Hooks
export { useBreadcrumb } from "./hooks/use-breadcrumb";
export { useTheme } from "./hooks/use-theme";
// i18n
export { default as i18n, changeLanguage, supportedLanguages, languageNames } from "./i18n";
export type { SupportedLanguage } from "./i18n";
export { useSchemaLabel, resolveSchemaLabel } from "./i18n/use-schema-label";
export { LanguageSwitcher } from "./components/language-switcher";
// Utilities
export { cn } from "./lib/utils";
export { LoginPage } from "./pages/login";
// Page components
export { SchemaFormPage } from "./pages/schema-form";
export { SchemaListPage } from "./pages/schema-list";
export { WorkspacePage } from "./pages/workspace";
