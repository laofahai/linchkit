/**
 * System config schemas — infrastructure configs needed before DB is available.
 *
 * Fields sourced from $env.* use z.coerce for proper string->number/boolean conversion.
 */

import { z } from "zod";
import { defineConfigSchema } from "./define-config-schema";

export const serverConfig = defineConfigSchema("system:server", {
  port: z.coerce.number().default(3001),
  host: z.string().default("0.0.0.0"),
});

export const databaseConfig = defineConfigSchema("system:database", {
  url: z.string().optional(),
  poolSize: z.coerce.number().default(10),
  debug: z.coerce.boolean().default(false),
});

export const queueConfig = defineConfigSchema("system:queue", {
  pollInterval: z.coerce.number().default(1000),
  batchSize: z.coerce.number().default(10),
});

export const securityConfig = defineConfigSchema("system:security", {
  encryption: z
    .object({
      keyProvider: z.enum(["env", "kms"]).default("env"),
      keyEnvVar: z.string().default("LINCHKIT_ENCRYPTION_KEY"),
      keyVersion: z.coerce.number().default(1),
    })
    .optional(),
});
