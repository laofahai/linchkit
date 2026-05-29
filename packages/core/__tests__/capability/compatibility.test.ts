import { describe, expect, it } from "bun:test";
import {
  type CompatCapability,
  checkCoreCompatibility,
  enforceCoreCompatibility,
} from "../../src/capability/compatibility";
import { LinchKitError } from "../../src/errors";
import type { Logger } from "../../src/types/logger";

// ── Helpers ──────────────────────────────────────────────

/** A logger that records every warn() invocation for assertions. */
function recordingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const noop = () => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: (message) => warnings.push(message),
    error: noop,
  };
  return { logger, warnings };
}

const cap = (name: string, coreVersion?: string): CompatCapability => ({ name, coreVersion });

// ── checkCoreCompatibility ───────────────────────────────

describe("checkCoreCompatibility", () => {
  it("reports no warnings when every range is satisfied", () => {
    // Note: ^0.2.0 locks to the 0.2.x minor (npm caret on 0.y.z), so it does
    // NOT include 0.3.0 — use ^0.3.0 / a compound range for a 0.3.0 core.
    const result = checkCoreCompatibility(
      [cap("a", "^0.3.0"), cap("b", ">=0.2.0 <0.4.0")],
      "0.3.0",
    );
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("reports a warning for an out-of-range capability", () => {
    const result = checkCoreCompatibility([cap("a", "^0.2.0")], "0.0.1");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.capability).toBe("a");
    expect(result.warnings[0]?.required).toBe("^0.2.0");
    expect(result.warnings[0]?.actual).toBe("0.0.1");
  });

  it("skips capabilities without a declared coreVersion range", () => {
    const result = checkCoreCompatibility([cap("a"), cap("b", undefined)], "0.0.1");
    expect(result.warnings).toEqual([]);
  });

  it("handles compound (AND) ranges", () => {
    const inRange = checkCoreCompatibility([cap("a", ">=0.2.0 <0.4.0")], "0.3.0");
    expect(inRange.warnings).toEqual([]);

    const outOfRange = checkCoreCompatibility([cap("a", ">=0.2.0 <0.4.0")], "0.4.0");
    expect(outOfRange.warnings).toHaveLength(1);
  });

  it("reports one warning per incompatible capability", () => {
    const result = checkCoreCompatibility(
      [cap("a", "^0.2.0"), cap("b", "^0.3.0"), cap("ok", "^0.0.1")],
      "0.0.1",
    );
    expect(result.warnings.map((w) => w.capability).sort()).toEqual(["a", "b"]);
  });
});

// ── enforceCoreCompatibility ─────────────────────────────

describe("enforceCoreCompatibility", () => {
  it("does nothing when all capabilities are compatible (strict)", () => {
    expect(() =>
      enforceCoreCompatibility([cap("a", "^0.3.0")], "0.3.0", { strict: true }),
    ).not.toThrow();
  });

  it("throws a LinchKitError listing mismatches in strict mode", () => {
    let caught: unknown;
    try {
      enforceCoreCompatibility([cap("a", "^0.2.0"), cap("b", "^0.3.0")], "0.0.1", {
        strict: true,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LinchKitError);
    const error = caught as LinchKitError;
    expect(error.code).toBe("capability.compatibility.core_version_mismatch");
    expect(error.message).toContain("a");
    expect(error.message).toContain("b");
    const mismatches = (error.details?.mismatches ?? []) as unknown[];
    expect(mismatches).toHaveLength(2);
  });

  it("warns (does not throw) in non-strict mode", () => {
    const { logger, warnings } = recordingLogger();
    expect(() =>
      enforceCoreCompatibility([cap("a", "^0.2.0")], "0.0.1", { strict: false, logger }),
    ).not.toThrow();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("a");
  });

  it("emits no warnings when everything is compatible in non-strict mode", () => {
    const { logger, warnings } = recordingLogger();
    enforceCoreCompatibility([cap("a", "^0.3.0")], "0.3.0", { strict: false, logger });
    expect(warnings).toEqual([]);
  });

  // The #122 boot-safety trap: core VERSION "0.0.1" + an addon declaring
  // "^0.2.0" must WARN, never throw, so the dev boot path is not broken.
  it("does NOT throw for VERSION=0.0.1 vs ^0.2.0 when strict is off", () => {
    const { logger, warnings } = recordingLogger();
    expect(() =>
      enforceCoreCompatibility([cap("cap-auth", "^0.2.0")], "0.0.1", {
        strict: false,
        logger,
      }),
    ).not.toThrow();
    expect(warnings).toHaveLength(1);
  });
});
