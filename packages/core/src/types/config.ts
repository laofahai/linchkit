/**
 * LinchKit project configuration types
 */

import type { FlowEngineConfig } from "../engine/flow/types";
import type { AIServiceConfig } from "./ai";
import type { CapabilityDefinition } from "./capability";

export interface LinchKitConfig {
  /** AI service configuration (optional — system works without it) */
  ai?: AIServiceConfig;

  /** Database configuration — when url is set, PostgreSQL is used instead of InMemoryStore */
  database?: {
    /** PostgreSQL connection URL (supports $env.DATABASE_URL pattern) */
    url?: string;
    /** Connection pool size (default: 10) */
    poolSize?: number;
    /** Enable query debug logging (default: false) */
    debug?: boolean;
  };

  /** Server configuration */
  server?: {
    port?: number;
    host?: string;
  };

  /** Queue configuration */
  queue?: {
    pollInterval?: number;
    batchSize?: number;
  };

  /** Security configuration (encryption key management etc.) */
  security?: {
    encryption?: {
      /** Key provider type */
      keyProvider?: "env" | "kms";
      /** Environment variable name holding the encryption key */
      keyEnvVar?: string;
      /** Key version for rotation */
      keyVersion?: number;
    };
  };

  /** GitHub integration */
  github?: {
    repo?: string;
    token?: string;
  };

  /** Flow engine configuration */
  flow?: FlowEngineConfig;

  /** Installed capabilities loaded by the host project */
  capabilities?: CapabilityDefinition[];
}
