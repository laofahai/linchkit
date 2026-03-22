/**
 * @linchkit/cap-adapter-ui-react — Frontend UI components + Headless hooks
 *
 * Shadcn + React + TanStack Router/Query/Table
 */

export const VERSION = "0.0.1";

export { useTheme } from "@linchkit/ui-kit/hooks";
// Utilities
export { cn } from "@linchkit/ui-kit/lib/utils";
// Capability definition
export { capAdapterUiReact } from "./capability";
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
// Hooks
export { useBreadcrumb } from "./hooks/use-breadcrumb";
export type { SupportedLanguage } from "./i18n";
// i18n
export { changeLanguage, default as i18n, languageNames, supportedLanguages } from "./i18n";
export { resolveSchemaLabel, useSchemaLabel } from "./i18n/use-schema-label";
// Layout components
export { ShellLayout } from "./layouts/shell";
// Page components
export { SchemaFormPage } from "./pages/schema-form";
export { SchemaListPage } from "./pages/schema-list";
export { WorkspacePage } from "./pages/workspace";
