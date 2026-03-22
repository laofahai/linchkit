/**
 * LinchKit project configuration types
 */

import type { AIServiceConfig } from "./ai";
import type { CapabilityDefinition } from "./capability";

export interface LinchKitConfig {
  /** AI service configuration (optional — system works without it) */
  ai?: AIServiceConfig;

  /** Database configuration */
  database?: {
    url?: string;
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

  /** GitHub integration */
  github?: {
    repo?: string;
    token?: string;
  };

  /** Installed capabilities loaded by the host project */
  capabilities?: CapabilityDefinition[];
}
