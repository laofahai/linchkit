import { executeAction } from "./action-api";

const AUTH_STORAGE_KEY = "linchkit:authenticated";
const TOKEN_STORAGE_KEY = "linchkit:token";

export function isAuthenticated(): boolean {
  return localStorage.getItem(AUTH_STORAGE_KEY) === "true";
}

export function markAuthenticated(authenticated: boolean): void {
  if (authenticated) {
    localStorage.setItem(AUTH_STORAGE_KEY, "true");
    return;
  }

  localStorage.removeItem(AUTH_STORAGE_KEY);
}

export async function loginWithPassword(email: string, password: string): Promise<void> {
  const result = await executeAction("login", { email, password });
  if (!result.success) {
    throw new Error(result.error?.message ?? "Login failed");
  }
  // Store the access token when the server returns one.
  // Server returns snake_case field names (access_token).
  const data = result.data as Record<string, unknown> | undefined;
  const token = data?.access_token ?? data?.accessToken;
  if (typeof token === "string") {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  }
  markAuthenticated(true);
}

export async function registerWithPassword(data: {
  name: string;
  email: string;
  password: string;
  acceptedTerms: boolean;
}): Promise<void> {
  const result = await executeAction("register", {
    name: data.name,
    email: data.email,
    password: data.password,
  });
  if (!result.success) {
    throw new Error(result.error?.message ?? "Registration failed");
  }
}

export async function requestPasswordReset(email: string): Promise<void> {
  const result = await executeAction("reset_password", { email });
  if (!result.success) {
    throw new Error(result.error?.message ?? "Password reset request failed");
  }
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const result = await executeAction("reset_password", {
    token,
    new_password: newPassword,
  });
  if (!result.success) {
    throw new Error(result.error?.message ?? "Password reset failed");
  }
}

export async function logout(): Promise<void> {
  try {
    await executeAction("logout", {});
  } catch {
    // Temporary fallback until a concrete auth provider is wired.
  }

  localStorage.removeItem(TOKEN_STORAGE_KEY);
  markAuthenticated(false);
}
