/**
 * @linchkit/cap-auth/ui — Authentication UI components
 *
 * Self-contained page components for login, registration, and password recovery.
 * These are presentation-only: action handlers are injected via props.
 *
 * Peer dependencies: @linchkit/ui-kit, react
 */

// Shared components
export type { OAuthButtonsProps, OAuthProvider } from "./components/oauth-buttons";
export { OAuthButtons } from "./components/oauth-buttons";
export type {
  ForgotPasswordPageLabels,
  ForgotPasswordPageProps,
  ForgotPasswordStep,
} from "./ForgotPasswordPage";
// Pages
export { ForgotPasswordPage } from "./ForgotPasswordPage";
export type { LoginPageLabels, LoginPageProps } from "./LoginPage";
export { LoginPage } from "./LoginPage";
export type { CreateAuthPageRegistryOptions } from "./page-registry";
export { createAuthPageRegistry } from "./page-registry";
export type { RegisterPageLabels, RegisterPageProps } from "./RegisterPage";
export { RegisterPage } from "./RegisterPage";
