/**
 * Environment gating for the Phase 4 generated-source contract check.
 *
 * `strictGeneratedContract` controls whether the heuristic generated-source
 * contract validation (validation-phase4) reports findings as blocking ERRORS
 * (production-like) or non-blocking WARNINGS (development). It moves in
 * lock-step with `strictCompatibility` (Phase 3): both derive from
 * `isProduction`, which includes staging.
 *
 * Kept in a focused module so the broad `deployment.test.ts` stays under the
 * file-size policy.
 */

import { describe, expect, it } from "bun:test";
import { detectEnvironment } from "../src/deployment";

describe("detectEnvironment — strictGeneratedContract", () => {
  it("blocks generated-source contract findings in production", () => {
    const config = detectEnvironment("production");
    expect(config.features.strictGeneratedContract).toBe(true);
    // Lock-step with the Phase 3 compatibility gate.
    expect(config.features.strictGeneratedContract).toBe(config.features.strictCompatibility);
  });

  it("blocks in staging (production-like)", () => {
    const config = detectEnvironment("staging");
    expect(config.isProduction).toBe(true);
    expect(config.features.strictGeneratedContract).toBe(true);
    expect(config.features.strictGeneratedContract).toBe(config.features.strictCompatibility);
  });

  it("stays warn-only in development", () => {
    const config = detectEnvironment("development");
    expect(config.features.strictGeneratedContract).toBe(false);
    expect(config.features.strictGeneratedContract).toBe(config.features.strictCompatibility);
  });
});
