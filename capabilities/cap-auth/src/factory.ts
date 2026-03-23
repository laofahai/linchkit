/**
 * createCapAuth — Factory that wires an AuthProvider into the cap-auth capability.
 *
 * Takes a concrete AuthProvider implementation and produces a fully wired
 * CapabilityDefinition with action handlers and middleware registration.
 *
 * Usage:
 * ```ts
 * import { createCapAuth } from '@linchkit/cap-auth'
 * import { createBetterAuthProvider } from '@linchkit/cap-auth-better-auth'
 *
 * const capAuth = createCapAuth({
 *   provider: createBetterAuthProvider({ database: db }),
 * })
 * ```
 */

import type {
  ActionDefinition,
  CapabilityDefinition,
  CapabilityMiddlewareRegistration,
} from "@linchkit/core";
import { defineCapability } from "@linchkit/core";
import { createApiKeyAction } from "./actions/create-api-key";
import { loginAction } from "./actions/login";
import { logoutAction } from "./actions/logout";
import { refreshTokenAction } from "./actions/refresh-token";
import { registerAction } from "./actions/register";
import { resetPasswordAction } from "./actions/reset-password";
import { capAuthConfig } from "./config";
import { createAuthMiddleware } from "./middleware/auth-middleware";
import { apiKeySchema } from "./schemas/api-key";
import { sessionSchema } from "./schemas/session";
import { tokenSchema } from "./schemas/token";
import { userSchema } from "./schemas/user";
import { userLifecycleState } from "./states/user-lifecycle";
import type { CapAuthOptions } from "./types";

/**
 * Wire a provider method into an action definition, producing a new action with a handler.
 */
function wireAction(
  action: ActionDefinition,
  handler: ActionDefinition["handler"],
): ActionDefinition {
  return { ...action, handler };
}

/**
 * Create a fully-wired cap-auth capability with a concrete AuthProvider.
 *
 * When no provider is supplied, the capability is returned as a pure contract
 * (actions without handlers). This is useful for type-checking and schema
 * registration without a concrete auth engine.
 */
export function createCapAuth(options?: CapAuthOptions): CapabilityDefinition {
  const provider = options?.provider;

  // Wire action handlers from the provider (if supplied)
  const actions: ActionDefinition[] = provider
    ? [
        wireAction(loginAction, async (ctx) =>
          provider.login(ctx, ctx.input as { email: string; password: string }),
        ),
        wireAction(logoutAction, async (ctx) => {
          await provider.logout(ctx, ctx.input as { session_id?: string });
        }),
        wireAction(refreshTokenAction, async (ctx) =>
          provider.refreshToken(ctx, ctx.input as { refresh_token: string }),
        ),
        wireAction(createApiKeyAction, async (ctx) =>
          provider.createApiKey(
            ctx,
            ctx.input as { name: string; scopes?: unknown; expires_at?: string },
          ),
        ),
        wireAction(resetPasswordAction, async (ctx) =>
          provider.resetPassword(
            ctx,
            ctx.input as { email?: string; token?: string; new_password?: string },
          ),
        ),
        wireAction(registerAction, async (ctx) =>
          provider.register(ctx, ctx.input as { name: string; email: string; password: string }),
        ),
      ]
    : [
        loginAction,
        logoutAction,
        refreshTokenAction,
        createApiKeyAction,
        resetPasswordAction,
        registerAction,
      ];

  // Build middleware registrations from provider resolvers
  // Uses the CapabilityDefinition.MiddlewareRegistration type (slot + handler + priority)
  const cfg = options?.config;
  const middlewares: CapabilityMiddlewareRegistration[] | undefined = provider
    ? [
        {
          slot: "auth" as const,
          handler: createAuthMiddleware({
            resolveToken: (token) => provider.resolveToken(token),
            resolveApiKey: (key) => provider.resolveApiKey(key),
            resolveSession: (sid) => provider.resolveSession(sid),
            sessionCookieName: cfg?.sessionCookieName as string | undefined,
            allowAnonymous: cfg?.allowAnonymous as boolean | undefined,
          }),
          priority: 50,
        },
      ]
    : undefined;

  return defineCapability({
    name: "cap-auth",
    label: "Authentication",
    description: "User authentication, session management, and API key support",
    type: "standard",
    category: "system",
    version: "0.0.1",

    configSchema: capAuthConfig.schema,
    config: cfg,

    dependencies: [],

    schemas: [userSchema, sessionSchema, apiKeySchema, tokenSchema],
    actions,
    states: [userLifecycleState],

    extensions: middlewares ? { middlewares } : undefined,

    systemPermissions: ["database.read", "database.write", "event.emit"],
  });
}
