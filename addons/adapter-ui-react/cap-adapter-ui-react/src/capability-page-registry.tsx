import { ForgotPasswordPage, LoginPage, RegisterPage } from "@linchkit/cap-auth/ui";
import type { PageRegistration } from "@linchkit/core/types";
import type { ComponentType } from "react";
import { useState } from "react";
import {
  loginWithPassword,
  registerWithPassword,
  requestPasswordReset,
  resetPassword,
} from "./lib/auth-client";

type PageComponent = ComponentType<Record<string, unknown>>;

/** Stateful login page wrapper — manages error/loading state */
function LoginPageWrapper() {
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  return (
    <LoginPage
      onLogin={async (email, password) => {
        setError(undefined);
        setLoading(true);
        try {
          await loginWithPassword(email, password);
          window.location.href = "/";
        } catch (err) {
          setError(err instanceof Error ? err.message : "Login failed");
        } finally {
          setLoading(false);
        }
      }}
      onForgotPassword={() => {
        window.location.href = "/forgot-password";
      }}
      onRegister={() => {
        window.location.href = "/register";
      }}
      loading={loading}
      error={error}
      labels={{
        title: "LinchKit",
        description: "Sign in to continue",
      }}
    />
  );
}

/** Stateful register page wrapper */
function RegisterPageWrapper() {
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  return (
    <RegisterPage
      onRegister={async (data) => {
        setError(undefined);
        setLoading(true);
        try {
          await registerWithPassword(data);
          window.location.href = "/login";
        } catch (err) {
          setError(err instanceof Error ? err.message : "Registration failed");
        } finally {
          setLoading(false);
        }
      }}
      onLogin={() => {
        window.location.href = "/login";
      }}
      loading={loading}
      error={error}
      labels={{
        description: "Sign up for LinchKit",
      }}
    />
  );
}

/** Stateful forgot-password page wrapper */
function ForgotPasswordPageWrapper() {
  return (
    <ForgotPasswordPage
      onRequestReset={async (email) => {
        await requestPasswordReset(email);
      }}
      onResetPassword={async ({ token, newPassword }) => {
        await resetPassword(token, newPassword);
        window.location.href = "/login";
      }}
      onBackToLogin={() => {
        window.location.href = "/login";
      }}
    />
  );
}

const PAGE_COMPONENTS: Record<string, PageComponent> = {
  "auth:login": LoginPageWrapper,
  "auth:register": RegisterPageWrapper,
  "auth:forgot-password": ForgotPasswordPageWrapper,
};

/** Register a page component at runtime (for capabilities that provide UI). */
export function registerPageComponent(componentId: string, component: PageComponent): void {
  PAGE_COMPONENTS[componentId] = component;
}

export function resolveCapabilityPageComponent(page: PageRegistration): PageComponent {
  const component = PAGE_COMPONENTS[page.component];
  if (!component) {
    // Return a fallback component instead of throwing — the capability may
    // define pages that the current UI bundle doesn't have components for.
    return () => (
      <div style={{ padding: 32 }}>
        <h2>Page component not found</h2>
        <p>
          No UI component registered for <code>{page.component}</code>.
        </p>
      </div>
    );
  }
  return component;
}
