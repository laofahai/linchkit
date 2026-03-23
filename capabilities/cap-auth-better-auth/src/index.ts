/**
 * @linchkit/cap-auth-better-auth — better-auth implementation for cap-auth
 *
 * Provides a concrete AuthProvider that uses better-auth as the
 * authentication engine. This is the recommended auth provider for
 * LinchKit applications requiring production-grade auth.
 *
 * better-auth manages its own database tables (user, session, account,
 * verification) automatically via the Drizzle adapter. These are separate
 * from LinchKit's cap-auth schema tables.
 *
 * Usage:
 * ```ts
 * import { createCapAuth } from '@linchkit/cap-auth'
 * import { createBetterAuthProvider } from '@linchkit/cap-auth-better-auth'
 * import { drizzle } from 'drizzle-orm/postgres-js'
 * import postgres from 'postgres'
 *
 * const db = drizzle(postgres(process.env.DATABASE_URL!))
 *
 * const capAuth = createCapAuth({
 *   provider: createBetterAuthProvider({ database: db }),
 * })
 * ```
 */

export type { CapAuthBetterAuthOptions } from "./capability";
export { capAuthBetterAuth } from "./capability";
export type { BetterAuthProviderOptions, SeedAdminOptions } from "./provider";
export { createBetterAuthProvider, registerUser, seedSystemAdmin } from "./provider";
