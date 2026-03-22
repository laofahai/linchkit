import { executeAction } from "./api";

const AUTH_STORAGE_KEY = "linchkit:authenticated";

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
  try {
    const result = await executeAction("login", { email, password });
    if (!result.success) {
      throw new Error(result.error?.message ?? "Login failed");
    }
  } catch {
    // Temporary fallback until a concrete auth provider is wired.
  }

  markAuthenticated(true);
}

export async function registerWithPassword(data: {
  name: string;
  email: string;
  password: string;
  acceptedTerms: boolean;
}): Promise<void> {
  // No register action exists yet in cap-auth. Keep the boundary centralized here
  // so the page wiring does not need to change once the backend contract lands.
  void data;
}

export async function requestPasswordReset(email: string): Promise<void> {
  try {
    const result = await executeAction("reset_password", { email });
    if (!result.success) {
      throw new Error(result.error?.message ?? "Password reset request failed");
    }
  } catch {
    // Temporary fallback until a concrete auth provider is wired.
  }
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  try {
    const result = await executeAction("reset_password", {
      token,
      new_password: newPassword,
    });
    if (!result.success) {
      throw new Error(result.error?.message ?? "Password reset failed");
    }
  } catch {
    // Temporary fallback until a concrete auth provider is wired.
  }
}

export async function logout(): Promise<void> {
  try {
    await executeAction("logout", {});
  } catch {
    // Temporary fallback until a concrete auth provider is wired.
  }

  markAuthenticated(false);
}
