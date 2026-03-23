/**
 * LoginPage — Based on shadcn/ui login-01 block.
 *
 * This is a self-contained page component. All action handlers are
 * injected via props — no API calls happen inside this component.
 */

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from "@linchkit/ui-kit/components";
import { type FormEvent, type ReactNode, useState } from "react";
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
    title = "Login",
    description = "Enter your email below to login to your account",
    emailLabel = "Email",
    emailPlaceholder = "m@example.com",
    passwordLabel = "Password",
    passwordPlaceholder = "",
    submitButton = "Login",
    forgotPasswordLink = "Forgot your password?",
    registerPrompt = "Don\u2019t have an account?",
    registerLink = "Sign up",
    oauthDivider = "or",
  } = labels;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onLogin(email, password);
  };

  return (
    <div className="flex w-full max-w-md flex-col gap-6">
      <Card>
        <CardHeader>
          {logo && <div className="mb-2 flex justify-center">{logo}</div>}
          <CardTitle className="text-2xl">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit}>
            <div className="flex flex-col gap-6">
              {error && (
                <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}

              {oauthProviders.length > 0 && onOAuthLogin && (
                <OAuthButtons
                  providers={oauthProviders}
                  onProviderClick={onOAuthLogin}
                  loading={loading}
                  dividerLabel={oauthDivider}
                />
              )}

              <div className="grid gap-2">
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

              <div className="grid gap-2">
                <div className="flex items-center">
                  <Label htmlFor="login-password">{passwordLabel}</Label>
                  {onForgotPassword && (
                    <button
                      type="button"
                      className="ml-auto inline-block text-sm underline-offset-4 hover:underline"
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
            </div>

            {onRegister && (
              <div className="mt-4 text-center text-sm">
                {registerPrompt}{" "}
                <button type="button" className="underline underline-offset-4" onClick={onRegister}>
                  {registerLink}
                </button>
              </div>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
