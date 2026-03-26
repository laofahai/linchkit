/**
 * LinchKit project configuration types
 */

import type { FlowEngineConfig } from "../flow/types";
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

  /** Realtime subscription configuration (SSE-based server→client push) */
  subscription?: SubscriptionConfig;

  /** Installed capabilities loaded by the host project */
  capabilities?: CapabilityDefinition[];
}

/** Configuration for the SSE realtime subscription system */
export interface SubscriptionConfig {
  /** Whether subscription is enabled (default: true when server capability is loaded) */
  enabled?: boolean;
  /** Maximum SSE connections per user (default: 3) */
  maxConnectionsPerUser?: number;
  /** Heartbeat interval in milliseconds (default: 30000) */
  heartbeatInterval?: number;
  /** Idle timeout in milliseconds — close connection after no subscribed events (default: 300000) */
  idleTimeout?: number;
  /** Maximum buffered events per connection before dropping (default: 100) */
  maxBufferSize?: number;
}
