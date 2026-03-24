/**
 * Database configuration types
 */

export interface DatabaseConfig {
  /** PostgreSQL connection URL (e.g., postgres://user:pass@host:5432/db) */
  url: string;
  /** Connection pool size (default: 10) */
  poolSize?: number;
  /** Enable query debug logging (default: false) */
  debug?: boolean;
}
