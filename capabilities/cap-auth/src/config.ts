/**
 * cap-auth configuration schema
 *
 * Declares the config keys that cap-auth needs. Values come from
 * `linchkit.config.ts` and are validated at startup via ConfigRegistry.
 */

import { defineConfigSchema } from "@linchkit/core/config";
import { z } from "zod";

export const capAuthConfig = defineConfigSchema("cap-auth", {
  jwtSecret: z.string().describe("JWT signing secret"),
  tokenExpiry: z.coerce.number().default(3600).describe("Token expiry in seconds"),
  sessionCookieName: z.string().default("session"),
  allowAnonymous: z.boolean().default(false),
});
