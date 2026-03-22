import { createAuthPageRegistry } from "@linchkit/cap-auth/ui";
import type { PageRegistration } from "@linchkit/core/types";
import type { ComponentType } from "react";
import {
  loginWithPassword,
  registerWithPassword,
  requestPasswordReset,
  resetPassword,
} from "./lib/auth-client";

type PageComponent = ComponentType<Record<string, unknown>>;
const PAGE_COMPONENTS: Record<string, PageComponent> = createAuthPageRegistry({
  login: {
    onLogin: async (email, password) => {
      await loginWithPassword(email, password);
      window.location.href = "/";
    },
    onForgotPassword: () => {
      window.location.href = "/forgot-password";
    },
    onRegister: () => {
      window.location.href = "/register";
    },
    labels: {
      title: "LinchKit",
      description: "Sign in to continue",
    },
  },
  register: {
    onRegister: async (data) => {
      await registerWithPassword(data);
      window.location.href = "/login";
    },
    onLogin: () => {
      window.location.href = "/login";
    },
    labels: {
      description: "Sign up for LinchKit",
    },
  },
  forgotPassword: {
    onRequestReset: async (email) => {
      await requestPasswordReset(email);
    },
    onResetPassword: async ({ token, newPassword }) => {
      await resetPassword(token, newPassword);
      window.location.href = "/login";
    },
    onBackToLogin: () => {
      window.location.href = "/login";
    },
  },
});

export function resolveCapabilityPageComponent(page: PageRegistration): PageComponent {
  const component = PAGE_COMPONENTS[page.component];
  if (!component) {
    throw new Error(`Capability page component not registered: ${page.component}`);
  }
  return component;
}
