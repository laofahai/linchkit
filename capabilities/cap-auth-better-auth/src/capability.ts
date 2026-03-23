/**
 * capAuthBetterAuth — Capability definition that registers better-auth
 * as the auth provider via the extension system.
 *
 * Usage:
 * ```ts
 * import { capAuthBetterAuth } from '@linchkit/cap-auth-better-auth'
 *
 * defineConfig({
 *   capabilities: [
 *     createCapAuth(),                    // core auth contract
 *     capAuthBetterAuth({ secret: "..." }), // registers better-auth provider
 *   ],
 * })
 * ```
 */

import type { CapabilityDefinition } from "@linchkit/core";
import { defineCapability } from "@linchkit/core";
import { createBetterAuthProvider, seedSystemAdmin } from "./provider";

export interface CapAuthBetterAuthOptions {
  /** Secret key for session token signing. Defaults to JWT_SECRET env var, then "dev-secret". */
  secret?: string;
  /** Base URL for better-auth (used for callbacks, redirects). Defaults to "http://localhost:3001". */
  baseURL?: string;
}

/**
 * Create a capability that registers better-auth as the auth provider.
 *
 * This capability uses `extensions.authProvider` so that cap-auth can
 * discover the concrete provider at runtime without hardcoded imports.
 */
export function capAuthBetterAuth(options?: CapAuthBetterAuthOptions): CapabilityDefinition {
  return defineCapability({
    name: "cap-auth-better-auth",
    label: "BetterAuth Provider",
    description: "Registers better-auth as the authentication provider for cap-auth",
    type: "adapter",
    category: "system",
    version: "0.0.1",

    dependencies: ["cap-auth"],

    extensions: {
      authProvider: {
        name: "better-auth",
        create: (ctx) =>
          createBetterAuthProvider({
            database: ctx.database,
            secret: options?.secret,
            baseURL: options?.baseURL,
          }),
        seedAdmin: (ctx) => seedSystemAdmin({ database: ctx.database }),
      },
    },
  });
}
