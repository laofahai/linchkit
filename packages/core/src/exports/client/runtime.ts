/**
 * Runtime helpers — env validation + override resolution (Spec 12). Browser-safe.
 */

// Runtime env validation — Spec 12 deployment foundation (pure)
export {
  type EnvValidationResult,
  OPTIONAL_ENV_VARS,
  REQUIRED_ENV_VARS,
  validateEnv,
} from "../../runtime/env";
// Runtime override resolution (Layer 2 tenant overrides — pure logic)
export {
  applyOverride,
  deepMerge,
  type Overridable,
  resolveOverrides,
  resolveRuleOverride,
} from "../../runtime/override-resolver";
