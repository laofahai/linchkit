/**
 * Dev-mode role switching — stores and retrieves the selected dev role.
 *
 * DEVELOPMENT AFFORDANCE, NOT AN AUTH MECHANISM. The selected role is sent as
 * the `x-dev-role` header on all API requests so the no-auth dev server
 * (`dev-actor-resolver.ts` in cap-adapter-server) resolves the request to the
 * matching demo actor (user / manager / admin). Persisted to localStorage so
 * it survives page reloads — mirrors `tenant.ts`.
 *
 * Production servers configure a real auth resolver and never read this
 * header, so a stale stored value is inert outside dev.
 */

const STORAGE_KEY = "linchkit:dev-role";

/** Header recognized by the dev server's role-switching actor resolver. */
export const DEV_ROLE_HEADER = "x-dev-role";

/** Roles understood by the dev server, least to most privileged. */
export const DEV_ROLES = ["user", "manager", "admin"] as const;

export type DevRole = (typeof DEV_ROLES)[number];

/** Default role — matches the elevated no-auth actor the dev server resolves without the header. */
export const DEFAULT_DEV_ROLE: DevRole = "admin";

function isDevRole(value: string | null): value is DevRole {
  return value !== null && (DEV_ROLES as readonly string[]).includes(value);
}

/**
 * Get the explicitly stored dev role choice, or null when none was made
 * (or the stored value is not a recognized role).
 */
export function getStoredDevRole(): DevRole | null {
  if (typeof localStorage === "undefined") return null;
  const stored = localStorage.getItem(STORAGE_KEY);
  return isDevRole(stored) ? stored : null;
}

/**
 * Get the effective dev role: the stored choice, falling back to `admin`
 * (= today's elevated no-auth behavior when no header is sent).
 */
export function getDevRole(): DevRole {
  return getStoredDevRole() ?? DEFAULT_DEV_ROLE;
}

/**
 * Set the dev role. Pass null to clear the explicit choice (the effective
 * role then falls back to the `admin` default and no header is sent).
 */
export function setDevRole(role: DevRole | null): void {
  if (typeof localStorage === "undefined") return;
  if (role) {
    localStorage.setItem(STORAGE_KEY, role);
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

/**
 * Build dev-role request headers.
 * Returns an empty object when no explicit choice was made — requests then
 * carry no `x-dev-role` header and the dev server keeps its elevated default,
 * so setups that never touch the switcher behave exactly as before.
 */
export function getDevRoleHeaders(): Record<string, string> {
  // Production guard: the switcher UI is dev-only, but this helper is called
  // from the always-bundled API modules — without the gate, a stale
  // localStorage value from a dev session would silently downgrade (or alter)
  // the caller's identity on a production deployment. `import.meta.env.PROD`
  // is statically replaced by Vite, so production builds compile this to an
  // unconditional empty return.
  if (import.meta.env.PROD) return {};
  const role = getStoredDevRole();
  if (role) {
    return { [DEV_ROLE_HEADER]: role };
  }
  return {};
}
