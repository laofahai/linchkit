/**
 * Environment gating for the Phase 5 execution dry-run check (Spec 70 §7).
 *
 * `strictExecutionDryRun` controls whether Phase 5 execution dry-run CONTENT
 * findings block proposal validation (vs warn-only). Unlike its strict
 * siblings (`strictCompatibility` / `strictGeneratedContract`) it is OPT-IN
 * EVERYWHERE — never derived from `isProduction` — because the dry-run depends
 * on external sandbox infrastructure: auto-blocking in prod on an
 * un-configured or flaky sandbox would wedge graduation. It flips on ONLY via
 * the explicit `LINCHKIT_STRICT_EXECUTION_DRY_RUN=1` override.
 *
 * Kept in a focused module so the broad `deployment.test.ts` stays under the
 * file-size policy (mirrors deployment.strict-generated-contract.test.ts).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { detectEnvironment } from "../src/deployment";

const ENV_VAR = "LINCHKIT_STRICT_EXECUTION_DRY_RUN";

describe("detectEnvironment — strictExecutionDryRun", () => {
  let savedValue: string | undefined;

  beforeEach(() => {
    savedValue = process.env[ENV_VAR];
    delete process.env[ENV_VAR];
  });

  afterEach(() => {
    if (savedValue === undefined) {
      delete process.env[ENV_VAR];
    } else {
      process.env[ENV_VAR] = savedValue;
    }
  });

  it("defaults to false in development", () => {
    const config = detectEnvironment("development");
    expect(config.features.strictExecutionDryRun).toBe(false);
  });

  it("defaults to false in test", () => {
    const config = detectEnvironment("test");
    expect(config.features.strictExecutionDryRun).toBe(false);
  });

  it("defaults to false in PRODUCTION (opt-in everywhere — NOT derived from isProduction)", () => {
    const config = detectEnvironment("production");
    expect(config.isProduction).toBe(true);
    expect(config.features.strictExecutionDryRun).toBe(false);
    // Explicitly diverges from the prod-derived strict siblings.
    expect(config.features.strictCompatibility).toBe(true);
    expect(config.features.strictGeneratedContract).toBe(true);
  });

  it("defaults to false in staging (production-like)", () => {
    const config = detectEnvironment("staging");
    expect(config.isProduction).toBe(true);
    expect(config.features.strictExecutionDryRun).toBe(false);
  });

  it("LINCHKIT_STRICT_EXECUTION_DRY_RUN=1 opts in (any environment)", () => {
    process.env[ENV_VAR] = "1";
    expect(detectEnvironment("development").features.strictExecutionDryRun).toBe(true);
    expect(detectEnvironment("production").features.strictExecutionDryRun).toBe(true);
  });

  it('ignores non-"1" values (strict opt-in, fail-safe to warn-only)', () => {
    process.env[ENV_VAR] = "true";
    expect(detectEnvironment("production").features.strictExecutionDryRun).toBe(false);
    process.env[ENV_VAR] = "0";
    expect(detectEnvironment("production").features.strictExecutionDryRun).toBe(false);
    process.env[ENV_VAR] = "";
    expect(detectEnvironment("production").features.strictExecutionDryRun).toBe(false);
  });
});
