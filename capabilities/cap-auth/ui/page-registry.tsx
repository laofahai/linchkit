import type { ComponentType } from "react";
import { ForgotPasswordPage, type ForgotPasswordPageProps } from "./ForgotPasswordPage";
import { LoginPage, type LoginPageProps } from "./LoginPage";
import { RegisterPage, type RegisterPageProps } from "./RegisterPage";

type AuthPageComponent = ComponentType<Record<string, unknown>>;

export interface CreateAuthPageRegistryOptions {
  login: LoginPageProps;
  register: RegisterPageProps;
  forgotPassword: ForgotPasswordPageProps;
}

export function createAuthPageRegistry(
  options: CreateAuthPageRegistryOptions,
): Record<string, AuthPageComponent> {
  return {
    "auth:login": () => <LoginPage {...options.login} />,
    "auth:register": () => <RegisterPage {...options.register} />,
    "auth:forgot-password": () => <ForgotPasswordPage {...options.forgotPassword} />,
  };
}
