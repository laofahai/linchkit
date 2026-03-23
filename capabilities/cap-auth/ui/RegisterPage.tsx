/**
 * RegisterPage — Based on shadcn/ui login-01 block style.
 *
 * Collects name, email, password, confirm password, and an optional
 * terms-of-service checkbox. All action handlers are injected via props.
 */

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
  Label,
} from "@linchkit/ui-kit/components";
import { type FormEvent, type ReactNode, useState } from "react";
import { OAuthButtons, type OAuthProvider } from "./components/oauth-buttons";

export interface RegisterPageLabels {
  title?: string;
  description?: string;
  nameLabel?: string;
  namePlaceholder?: string;
  emailLabel?: string;
  emailPlaceholder?: string;
  passwordLabel?: string;
  passwordPlaceholder?: string;
  confirmPasswordLabel?: string;
  confirmPasswordPlaceholder?: string;
  termsLabel?: string;
  submitButton?: string;
  loginPrompt?: string;
  loginLink?: string;
  oauthDivider?: string;
  passwordMismatchError?: string;
}

export interface RegisterPageProps {
  /** Called when the user submits the registration form */
  onRegister: (data: {
    name: string;
    email: string;
    password: string;
    acceptedTerms: boolean;
  }) => void | Promise<void>;
  /** Called when a user clicks an OAuth provider button */
  onOAuthRegister?: (providerId: string) => void;
  /** Called when "Sign in" link is clicked */
  onLogin?: () => void;
  /** OAuth providers to display */
  oauthProviders?: OAuthProvider[];
  /** Whether the form is in a loading/submitting state */
  loading?: boolean;
  /** Error message to display */
  error?: string;
  /** Whether to show the terms checkbox (default: false) */
  showTerms?: boolean;
  /** Optional logo element */
  logo?: ReactNode;
  /** i18n label overrides */
  labels?: RegisterPageLabels;
}

export function RegisterPage({
  onRegister,
  onOAuthRegister,
  onLogin,
  oauthProviders = [],
  loading = false,
  error,
  showTerms = false,
  logo,
  labels = {},
}: RegisterPageProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const {
    title = "Create account",
    description = "Enter your details to get started",
    nameLabel = "Name",
    namePlaceholder = "",
    emailLabel = "Email",
    emailPlaceholder = "m@example.com",
    passwordLabel = "Password",
    passwordPlaceholder = "",
    confirmPasswordLabel = "Confirm password",
    confirmPasswordPlaceholder = "",
    termsLabel = "I agree to the terms and conditions",
    submitButton = "Create account",
    loginPrompt = "Already have an account?",
    loginLink = "Sign in",
    oauthDivider = "or",
    passwordMismatchError = "Passwords do not match",
  } = labels;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    if (password !== confirmPassword) {
      setLocalError(passwordMismatchError);
      return;
    }

    onRegister({ name, email, password, acceptedTerms });
  };

  const displayError = error ?? localError;

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
              {displayError && (
                <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {displayError}
                </div>
              )}

              {oauthProviders.length > 0 && onOAuthRegister && (
                <OAuthButtons
                  providers={oauthProviders}
                  onProviderClick={onOAuthRegister}
                  loading={loading}
                  dividerLabel={oauthDivider}
                />
              )}

              <div className="grid gap-2">
                <Label htmlFor="register-name">{nameLabel}</Label>
                <Input
                  id="register-name"
                  type="text"
                  placeholder={namePlaceholder}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  disabled={loading}
                  autoComplete="name"
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="register-email">{emailLabel}</Label>
                <Input
                  id="register-email"
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
                <Label htmlFor="register-password">{passwordLabel}</Label>
                <Input
                  id="register-password"
                  type="password"
                  placeholder={passwordPlaceholder}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={loading}
                  autoComplete="new-password"
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="register-confirm-password">{confirmPasswordLabel}</Label>
                <Input
                  id="register-confirm-password"
                  type="password"
                  placeholder={confirmPasswordPlaceholder}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  disabled={loading}
                  autoComplete="new-password"
                />
              </div>

              {showTerms && (
                <div className="flex items-start space-x-2">
                  <Checkbox
                    id="register-terms"
                    checked={acceptedTerms}
                    onCheckedChange={(checked) => setAcceptedTerms(checked === true)}
                    disabled={loading}
                  />
                  <Label htmlFor="register-terms" className="text-sm font-normal leading-snug">
                    {termsLabel}
                  </Label>
                </div>
              )}

              <Button
                type="submit"
                className="w-full"
                disabled={loading || (showTerms && !acceptedTerms)}
              >
                {loading ? "..." : submitButton}
              </Button>
            </div>

            {onLogin && (
              <div className="mt-4 text-center text-sm">
                {loginPrompt}{" "}
                <button type="button" className="underline underline-offset-4" onClick={onLogin}>
                  {loginLink}
                </button>
              </div>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
