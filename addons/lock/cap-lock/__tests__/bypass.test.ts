/**
 * Tests for the shared actor-level bypass predicate (Spec 63 §5.2).
 *
 * `evaluateActorBypass` is the single source of truth shared by the
 * `field-lock-check` interceptor and the `fieldLockBypass` GraphQL query.
 * Covers: shadow mode, bypass-group hit/miss, empty bypassGroups, an actor with
 * undefined groups (no throw), and an actor in a non-bypass group. Policies are
 * built via `resolveCapLockPolicy` so defaults match production.
 */

import { describe, expect, it } from "bun:test";
import type { Actor } from "@linchkit/core";
import { evaluateActorBypass } from "../src/bypass";
import { resolveCapLockPolicy } from "../src/config";

/** Build an actor; `groups` defaults to []. Pass `null` to omit `groups`. */
function makeActor(groups: string[] | null = []): Actor {
  if (groups === null) {
    // Simulate a malformed actor whose `groups` is undefined at runtime.
    return { type: "human", id: "user-1" } as unknown as Actor;
  }
  return { type: "human", id: "user-1", groups };
}

describe("evaluateActorBypass", () => {
  it("shadow mode → canBypass true, reason 'shadow'", () => {
    const policy = resolveCapLockPolicy({ shadowMode: true });
    expect(evaluateActorBypass(makeActor([]), policy)).toEqual({
      canBypass: true,
      reason: "shadow",
    });
  });

  it("shadow mode wins even when the actor is also in a bypass group", () => {
    const policy = resolveCapLockPolicy({ shadowMode: true, bypassGroups: ["admin"] });
    expect(evaluateActorBypass(makeActor(["admin"]), policy)).toEqual({
      canBypass: true,
      reason: "shadow",
    });
  });

  it("bypass-group match → canBypass true, reason 'bypass'", () => {
    const policy = resolveCapLockPolicy({ bypassGroups: ["admin", "finance_manager"] });
    expect(evaluateActorBypass(makeActor(["finance_manager"]), policy)).toEqual({
      canBypass: true,
      reason: "bypass",
    });
  });

  it("no match (actor in a non-bypass group) → canBypass false, reason null", () => {
    const policy = resolveCapLockPolicy({ bypassGroups: ["admin"] });
    expect(evaluateActorBypass(makeActor(["viewer"]), policy)).toEqual({
      canBypass: false,
      reason: null,
    });
  });

  it("empty bypassGroups → canBypass false even when the actor has groups", () => {
    const policy = resolveCapLockPolicy({ bypassGroups: [] });
    expect(evaluateActorBypass(makeActor(["admin"]), policy)).toEqual({
      canBypass: false,
      reason: null,
    });
  });

  it("actor with undefined groups → canBypass false, no throw", () => {
    const policy = resolveCapLockPolicy({ bypassGroups: ["admin"] });
    expect(() => evaluateActorBypass(makeActor(null), policy)).not.toThrow();
    expect(evaluateActorBypass(makeActor(null), policy)).toEqual({
      canBypass: false,
      reason: null,
    });
  });

  it("default policy (no knobs) → canBypass false", () => {
    const policy = resolveCapLockPolicy();
    expect(evaluateActorBypass(makeActor(["admin"]), policy)).toEqual({
      canBypass: false,
      reason: null,
    });
  });

  it("ignores toleranceMs (actor-level subset only)", () => {
    // A generous tolerance window must NOT make the actor bypass-eligible —
    // tolerance is record-age based and stays interceptor-only.
    const policy = resolveCapLockPolicy({ toleranceMs: 60_000 });
    expect(evaluateActorBypass(makeActor(["admin"]), policy)).toEqual({
      canBypass: false,
      reason: null,
    });
  });
});
