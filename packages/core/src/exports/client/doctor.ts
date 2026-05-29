/**
 * Doctor — project health check registry (browser-safe; server adds builtin checks).
 */

export type {
  CheckCategory,
  CheckStatus,
  DoctorCheck,
  DoctorCheckResult,
  DoctorContext,
} from "../../doctor";
export { clearDoctorChecks, getDoctorChecks, registerDoctorCheck } from "../../doctor";
