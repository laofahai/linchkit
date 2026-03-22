/**
 * @linchkit/cap-auth-better-auth — better-auth implementation for cap-auth
 *
 * Provides a concrete AuthProvider that uses better-auth as the
 * authentication engine. This is the recommended auth provider for
 * LinchKit applications.
 *
 * Usage:
 * ```ts
 * import { createCapAuth } from '@linchkit/cap-auth'
 * import { createBetterAuthProvider } from '@linchkit/cap-auth-better-auth'
 *
 * const capAuth = createCapAuth({
 *   provider: createBetterAuthProvider({
 *     auth: betterAuth({ database: drizzleAdapter(db) }),
 *   }),
 * })
 * ```
 */

export type { BetterAuthProviderOptions } from "./provider";
export { createBetterAuthProvider } from "./provider";
