/**
 * ForgotPasswordPage — Multi-step password recovery flow.
 *
 * Step 1: Enter email address to request a reset link.
 * Step 2: Confirmation message ("Check your inbox").
 * Step 3: Enter reset token + new password (when user arrives from email link).
 *
 * The active step can be controlled externally via `initialStep` or managed
 * internally. All action handlers are injected via props.
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

export type ForgotPasswordStep = "request" | "check-inbox" | "reset";

export interface ForgotPasswordPageLabels {
  // Step 1: Request
  requestTitle?: string;
  requestDescription?: string;
  emailLabel?: string;
  emailPlaceholder?: string;
  sendResetButton?: string;
  // Step 2: Check inbox
  checkInboxTitle?: string;
  checkInboxDescription?: string;
  resendButton?: string;
  // Step 3: Reset
  resetTitle?: string;
  resetDescription?: string;
  tokenLabel?: string;
  tokenPlaceholder?: string;
  newPasswordLabel?: string;
  newPasswordPlaceholder?: string;
  confirmPasswordLabel?: string;
  confirmPasswordPlaceholder?: string;
  resetButton?: string;
  // Shared
  backToLoginLink?: string;
  successTitle?: string;
  successDescription?: string;
  successBackToLoginButton?: string;
  passwordMismatchError?: string;
}

export interface ForgotPasswordPageProps {
  /** Called when user submits their email to request a reset */
  onRequestReset: (email: string) => void | Promise<void>;
  /** Called when user submits the reset form (token + new password) */
  onResetPassword: (data: { token: string; newPassword: string }) => void | Promise<void>;
  /** Called when "Back to login" is clicked */
  onBackToLogin?: () => void;
  /** Initial step to display (default: "request") */
  initialStep?: ForgotPasswordStep;
  /** Pre-filled token (e.g. from URL query param) */
  initialToken?: string;
  /** Whether the form is in a loading/submitting state */
  loading?: boolean;
  /** Error message to display */
  error?: string;
  /** Optional logo element */
  logo?: ReactNode;
  /** i18n label overrides */
  labels?: ForgotPasswordPageLabels;
}

export function ForgotPasswordPage({
  onRequestReset,
  onResetPassword,
  onBackToLogin,
  initialStep = "request",
  initialToken = "",
  loading = false,
  error,
  logo,
  labels = {},
}: ForgotPasswordPageProps) {
  const [step, setStep] = useState<ForgotPasswordStep | "success">(
    initialToken ? "reset" : initialStep,
  );
  const [email, setEmail] = useState("");
  const [token, setToken] = useState(initialToken);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const {
    requestTitle = "Forgot password",
    requestDescription = "Enter your email and we\u2019ll send you a reset link",
    emailLabel = "Email",
    emailPlaceholder = "m@example.com",
    sendResetButton = "Send reset link",
    checkInboxTitle = "Check your inbox",
    checkInboxDescription = "We\u2019ve sent a password reset link to your email address",
    resendButton = "Resend email",
    resetTitle = "Set new password",
    resetDescription = "Enter your reset token and a new password",
    tokenLabel = "Reset token",
    tokenPlaceholder = "",
    newPasswordLabel = "New password",
    newPasswordPlaceholder = "",
    confirmPasswordLabel = "Confirm new password",
    confirmPasswordPlaceholder = "",
    resetButton = "Reset password",
    backToLoginLink = "Back to sign in",
    successTitle = "Password reset",
    successDescription = "Your password has been successfully reset",
    successBackToLoginButton = "Back to sign in",
    passwordMismatchError = "Passwords do not match",
  } = labels;

  const displayError = error ?? localError;

  const handleRequestSubmit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await onRequestReset(email);
      setStep("check-inbox");
    } catch {
      // Parent handles error display via error prop
    }
  };

  const handleResetSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    if (newPassword !== confirmPassword) {
      setLocalError(passwordMismatchError);
      return;
    }

    try {
      await onResetPassword({ token, newPassword });
      setStep("success");
    } catch {
      // Parent handles error display via error prop
    }
  };

  const backToLoginFooter = onBackToLogin ? (
    <div className="mt-4 text-center text-sm">
      <button type="button" className="underline underline-offset-4" onClick={onBackToLogin}>
        {backToLoginLink}
      </button>
    </div>
  ) : null;

  // Step 1: Request reset
  if (step === "request") {
    return (
      <div className="flex w-full max-w-md flex-col gap-6">
        <Card>
          <CardHeader>
            {logo && <div className="mb-2 flex justify-center">{logo}</div>}
            <CardTitle className="text-2xl">{requestTitle}</CardTitle>
            <CardDescription>{requestDescription}</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleRequestSubmit}>
              <div className="flex flex-col gap-6">
                {displayError && (
                  <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {displayError}
                  </div>
                )}

                <div className="grid gap-2">
                  <Label htmlFor="forgot-email">{emailLabel}</Label>
                  <Input
                    id="forgot-email"
                    type="email"
                    placeholder={emailPlaceholder}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    disabled={loading}
                    autoComplete="email"
                  />
                </div>

                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? "..." : sendResetButton}
                </Button>
              </div>
              {backToLoginFooter}
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Step 2: Check inbox
  if (step === "check-inbox") {
    return (
      <div className="flex w-full max-w-md flex-col gap-6">
        <Card>
          <CardHeader>
            {logo && <div className="mb-2 flex justify-center">{logo}</div>}
            <CardTitle className="text-2xl">{checkInboxTitle}</CardTitle>
            <CardDescription>{checkInboxDescription}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col gap-4">
              <p className="text-center text-sm text-muted-foreground">{email}</p>

              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={loading}
                onClick={() => onRequestReset(email)}
              >
                {loading ? "..." : resendButton}
              </Button>

              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => setStep("reset")}
              >
                {resetTitle}
              </Button>
            </div>
            {backToLoginFooter}
          </CardContent>
        </Card>
      </div>
    );
  }

  // Success
  if (step === "success") {
    return (
      <div className="flex w-full max-w-md flex-col gap-6">
        <Card>
          <CardHeader>
            {logo && <div className="mb-2 flex justify-center">{logo}</div>}
            <CardTitle className="text-2xl">{successTitle}</CardTitle>
            <CardDescription>{successDescription}</CardDescription>
          </CardHeader>
          {onBackToLogin && (
            <CardContent>
              <Button type="button" className="w-full" onClick={onBackToLogin}>
                {successBackToLoginButton}
              </Button>
            </CardContent>
          )}
        </Card>
      </div>
    );
  }

  // Step 3: Reset password
  return (
    <div className="flex w-full max-w-md flex-col gap-6">
      <Card>
        <CardHeader>
          {logo && <div className="mb-2 flex justify-center">{logo}</div>}
          <CardTitle className="text-2xl">{resetTitle}</CardTitle>
          <CardDescription>{resetDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleResetSubmit}>
            <div className="flex flex-col gap-6">
              {displayError && (
                <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {displayError}
                </div>
              )}

              {!initialToken && (
                <div className="grid gap-2">
                  <Label htmlFor="reset-token">{tokenLabel}</Label>
                  <Input
                    id="reset-token"
                    type="text"
                    placeholder={tokenPlaceholder}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    required
                    disabled={loading}
                    autoComplete="off"
                  />
                </div>
              )}

              <div className="grid gap-2">
                <Label htmlFor="reset-new-password">{newPasswordLabel}</Label>
                <Input
                  id="reset-new-password"
                  type="password"
                  placeholder={newPasswordPlaceholder}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  disabled={loading}
                  autoComplete="new-password"
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="reset-confirm-password">{confirmPasswordLabel}</Label>
                <Input
                  id="reset-confirm-password"
                  type="password"
                  placeholder={confirmPasswordPlaceholder}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  disabled={loading}
                  autoComplete="new-password"
                />
              </div>

              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "..." : resetButton}
              </Button>
            </div>
            {backToLoginFooter}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
