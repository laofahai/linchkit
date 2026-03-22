/**
 * @linchkit/cap-auth — Authentication capability (contract layer)
 *
 * Provides the authentication contract: schemas, action interfaces,
 * middleware shell, and the AuthProvider interface.
 *
 * Concrete implementations (e.g. @linchkit/cap-auth-better-auth)
 * supply an AuthProvider to fill the contract with real logic.
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

// Actions (contract only, no handlers)
export { createApiKeyAction } from "./actions/create-api-key";
export { loginAction } from "./actions/login";
export { logoutAction } from "./actions/logout";
export { refreshTokenAction } from "./actions/refresh-token";
export { resetPasswordAction } from "./actions/reset-password";
// Static capability definition (pure contract, no handlers)
export { capAuth } from "./capability";
// Factory
export { createCapAuth } from "./factory";
// Middleware
export type { AuthResolverOptions } from "./middleware/auth-middleware";
export {
  createAuthMiddleware,
  createAuthMiddlewareRegistration,
} from "./middleware/auth-middleware";
// Providers
export { createDevAuthProvider } from "./providers/dev-provider";
// Schemas
export { apiKeySchema } from "./schemas/api-key";
export { sessionSchema } from "./schemas/session";
export { tokenSchema } from "./schemas/token";
export { userSchema } from "./schemas/user";
// State machines
export { userLifecycleState } from "./states/user-lifecycle";
// AuthProvider interface and types
export type {
  AuthProvider,
  CapAuthOptions,
  CreateApiKeyResult,
  LoginResult,
  RefreshResult,
  ResetPasswordResult,
} from "./types";
