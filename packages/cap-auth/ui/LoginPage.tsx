/**
 * LoginPage — Email + password login with optional OAuth buttons.
 *
 * This is a self-contained page component. All action handlers are
 * injected via props — no API calls happen inside this component.
 */

import { Button, Input, Label } from "@linchkit/ui-kit/components";
import { type FormEvent, type ReactNode, useState } from "react";
import { AuthCard } from "./components/auth-card";
import { OAuthButtons, type OAuthProvider } from "./components/oauth-buttons";

export interface LoginPageLabels {
  title?: string;
  description?: string;
  emailLabel?: string;
  emailPlaceholder?: string;
  passwordLabel?: string;
  passwordPlaceholder?: string;
  submitButton?: string;
  forgotPasswordLink?: string;
  registerPrompt?: string;
  registerLink?: string;
  oauthDivider?: string;
}

export interface LoginPageProps {
  /** Called when the user submits the login form */
  onLogin: (email: string, password: string) => void | Promise<void>;
  /** Called when a user clicks an OAuth provider button */
  onOAuthLogin?: (providerId: string) => void;
  /** Called when "Forgot password" link is clicked */
  onForgotPassword?: () => void;
  /** Called when "Register" link is clicked */
  onRegister?: () => void;
  /** OAuth providers to display */
  oauthProviders?: OAuthProvider[];
  /** Whether the form is in a loading/submitting state */
  loading?: boolean;
  /** Error message to display (e.g. "Invalid credentials") */
  error?: string;
  /** Optional logo element */
  logo?: ReactNode;
  /** i18n label overrides */
  labels?: LoginPageLabels;
}

export function LoginPage({
  onLogin,
  onOAuthLogin,
  onForgotPassword,
  onRegister,
  oauthProviders = [],
  loading = false,
  error,
  logo,
  labels = {},
}: LoginPageProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const {
    title = "Sign in",
    description = "Enter your credentials to continue",
    emailLabel = "Email",
    emailPlaceholder = "you@example.com",
    passwordLabel = "Password",
    passwordPlaceholder = "",
    submitButton = "Sign in",
    forgotPasswordLink = "Forgot password?",
    registerPrompt = "Don't have an account?",
    registerLink = "Register",
    oauthDivider = "or",
  } = labels;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onLogin(email, password);
  };

  return (
    <AuthCard
      title={title}
      description={description}
      logo={logo}
      footer={
        onRegister ? (
          <p>
            {registerPrompt}{" "}
            <button
              type="button"
              className="font-medium text-primary underline-offset-4 hover:underline"
              onClick={onRegister}
            >
              {registerLink}
            </button>
          </p>
        ) : undefined
      }
    >
      {oauthProviders.length > 0 && onOAuthLogin && (
        <OAuthButtons
          providers={oauthProviders}
          onProviderClick={onOAuthLogin}
          loading={loading}
          dividerLabel={oauthDivider}
        />
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        {error && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="login-email">{emailLabel}</Label>
          <Input
            id="login-email"
            type="email"
            placeholder={emailPlaceholder}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={loading}
            autoComplete="email"
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="login-password">{passwordLabel}</Label>
            {onForgotPassword && (
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-4 hover:text-primary hover:underline"
                onClick={onForgotPassword}
              >
                {forgotPasswordLink}
              </button>
            )}
          </div>
          <Input
            id="login-password"
            type="password"
            placeholder={passwordPlaceholder}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={loading}
            autoComplete="current-password"
          />
        </div>

        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? "..." : submitButton}
        </Button>
      </form>
    </AuthCard>
  );
}
