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
  /** Connection timeout in milliseconds (default: 5000) */
  connectTimeout?: number;
  /** Idle timeout for pool connections in milliseconds (default: 30000) */
  idleTimeout?: number;
  /** Called after a database connection is successfully created */
  onConnect?: () => void;
  /** Called after the database connection pool is closed */
  onClose?: () => void;
}
