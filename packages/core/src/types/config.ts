/**
 * LinchKit project configuration types
 */

export interface LinchKitConfig {
  /** Database configuration */
  database?: {
    url?: string;
  };

  /** System capabilities toggle */
  system?: {
    auth?: boolean;
    permission?: boolean;
    notification?: boolean;
    audit?: boolean;
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
}
