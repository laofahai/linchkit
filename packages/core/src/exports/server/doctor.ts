/**
 * Doctor — project health check registry + built-in checks (server).
 */

export type {
  CheckCategory,
  CheckStatus,
  DoctorCheck,
  DoctorCheckResult,
  DoctorContext,
} from "../../doctor";
export {
  builtinChecks,
  clearDoctorChecks,
  getDoctorChecks,
  registerDoctorCheck,
} from "../../doctor";
