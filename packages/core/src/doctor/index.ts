/**
 * Doctor module — project health check registry and built-in checks
 */

export { builtinChecks } from "./builtin-checks";
export type {
  CheckCategory,
  CheckStatus,
  DoctorCheck,
  DoctorCheckResult,
  DoctorContext,
} from "./doctor-registry";
export { clearDoctorChecks, getDoctorChecks, registerDoctorCheck } from "./doctor-registry";
