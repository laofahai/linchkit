/**
 * Doctor Registry — extensible health check system
 *
 * Core provides built-in checks; capabilities register their own
 * checks via `registerDoctorCheck()`.
 */

/** Possible outcomes of a single health check */
export type CheckStatus = "pass" | "fail" | "warn" | "skip";

/** Category for grouping checks in output */
export type CheckCategory = "runtime" | "database" | "definitions" | "quality" | "capability";

/** Result returned by a single health check */
export interface DoctorCheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  /** Shown when status is fail or warn */
  suggestion?: string;
}

/** Context passed to each check's run function */
export interface DoctorContext {
  /** Project root directory */
  projectRoot: string;
  /** Loaded LinchKit config (if available) */
  config?: Record<string, unknown>;
  /** Whether database is available */
  hasDatabase: boolean;
}

/** A single doctor check definition */
export interface DoctorCheck {
  name: string;
  description: string;
  /** Category for grouping output */
  category: CheckCategory;
  /** Run the check and return result */
  run(context: DoctorContext): Promise<DoctorCheckResult>;
}

// Internal mutable registry
let doctorChecks: DoctorCheck[] = [];

/** Register a doctor check (used by capabilities to add their own checks) */
export function registerDoctorCheck(check: DoctorCheck): void {
  doctorChecks.push(check);
}

/** Get all registered doctor checks */
export function getDoctorChecks(): DoctorCheck[] {
  return [...doctorChecks];
}

/** Clear all registered checks (for testing) */
export function clearDoctorChecks(): void {
  doctorChecks = [];
}
