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

/**
 * Built-in default list of meta keys to mask in execution-log output (Spec 65 §10.3).
 *
 * Matched case-insensitively against top-level meta keys at log-write time.
 * Values are replaced with `"***"` only in the persisted log entry — the
 * in-memory `ctx.meta.get("auth_token")` view stays plaintext for handlers.
 */
export const DEFAULT_EXECUTION_META_MASKED_KEYS: ReadonlyArray<string> = [
  "password",
  "token",
  "secret",
  "api_key",
] as const;

export const executionConfig = defineConfigSchema("system:execution", {
  meta: z
    .object({
      /**
       * Top-level meta keys to redact when an execution log entry is written.
       * Matching is case-insensitive (`"Password"` in meta hits a `"password"`
       * entry here). Values for matched keys become the literal string `"***"`
       * in the persisted log; the in-memory ExecutionMeta value is unchanged
       * so handlers that read sensitive context mid-execution still see the
       * real value.
       *
       * Nested-path masking (`user.password`) and glob/regex matching are
       * deliberately out of scope for v1 (Spec 65 §10.3 — "keys" not "paths").
       */
      maskedKeys: z.array(z.string()).default([...DEFAULT_EXECUTION_META_MASKED_KEYS]),
    })
    .default({ maskedKeys: [...DEFAULT_EXECUTION_META_MASKED_KEYS] }),
});
