/**
 * Tests for the cap-lock `fieldLockBypass` GraphQL extension (Spec 63 §5.2).
 *
 * Builds the extension, asserts the `FieldLockBypass` type shape, then invokes
 * the resolver with mock contexts covering: actor in a bypass group → bypass;
 * actor not in a group → no bypass; shadow-mode policy → shadow; and a
 * missing/undefined actor → no bypass with no throw. The resolver reuses the
 * SHARED `evaluateActorBypass`, so this asserts the read-side hint matches
 * enforcement.
 */

import { describe, expect, it } from "bun:test";
import type { Actor } from "@linchkit/core";
import {
  GraphQLBoolean,
  type GraphQLFieldConfig,
  type GraphQLFieldResolver,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from "graphql";
import { resolveCapLockPolicy } from "../src/config";
import { buildLockGraphQLExtension } from "../src/graphql";

function makeActor(groups: string[] = []): Actor {
  return { type: "human", id: "user-1", groups };
}

/** Pull the resolver out of the `fieldLockBypass` field config. */
function getResolver(
  field: GraphQLFieldConfig<unknown, unknown>,
): GraphQLFieldResolver<unknown, unknown> {
  const resolve = field.resolve;
  if (!resolve) throw new Error("fieldLockBypass field has no resolver");
  return resolve;
}

describe("buildLockGraphQLExtension", () => {
  it("exposes a single `fieldLockBypass` query field returning FieldLockBypass!", () => {
    const ext = buildLockGraphQLExtension({ policy: resolveCapLockPolicy() });
    expect(Object.keys(ext.queryFields)).toEqual(["fieldLockBypass"]);

    const field = ext.queryFields.fieldLockBypass;
    expect(field).toBeDefined();
    if (!field) return;

    // NonNull wrapper over the FieldLockBypass object type.
    expect(field.type).toBeInstanceOf(GraphQLNonNull);
    const inner = (field.type as GraphQLNonNull<GraphQLObjectType>).ofType;
    expect(inner).toBeInstanceOf(GraphQLObjectType);
    expect((inner as GraphQLObjectType).name).toBe("FieldLockBypass");
  });

  it("FieldLockBypass type has canBypass: Boolean! and reason: String", () => {
    const ext = buildLockGraphQLExtension({ policy: resolveCapLockPolicy() });
    const objectType = ext.types.find((t) => t.name === "FieldLockBypass");
    expect(objectType).toBeDefined();
    if (!objectType) return;

    const fields = objectType.getFields();
    // canBypass — NonNull Boolean.
    expect(fields.canBypass).toBeDefined();
    expect(fields.canBypass.type).toBeInstanceOf(GraphQLNonNull);
    expect((fields.canBypass.type as GraphQLNonNull<typeof GraphQLBoolean>).ofType).toBe(
      GraphQLBoolean,
    );
    // reason — nullable String.
    expect(fields.reason).toBeDefined();
    expect(fields.reason.type).toBe(GraphQLString);
  });

  it("resolves bypass for an actor in a bypass group", async () => {
    const ext = buildLockGraphQLExtension({
      policy: resolveCapLockPolicy({ bypassGroups: ["admin"] }),
    });
    const resolve = getResolver(ext.queryFields.fieldLockBypass);
    const result = await resolve({}, {}, { actor: makeActor(["admin"]) }, {} as never);
    expect(result).toEqual({ canBypass: true, reason: "bypass" });
  });

  it("resolves no-bypass for an actor not in a bypass group", async () => {
    const ext = buildLockGraphQLExtension({
      policy: resolveCapLockPolicy({ bypassGroups: ["admin"] }),
    });
    const resolve = getResolver(ext.queryFields.fieldLockBypass);
    const result = await resolve({}, {}, { actor: makeActor(["viewer"]) }, {} as never);
    expect(result).toEqual({ canBypass: false, reason: null });
  });

  it("resolves shadow for any actor under a shadowMode policy", async () => {
    const ext = buildLockGraphQLExtension({
      policy: resolveCapLockPolicy({ shadowMode: true }),
    });
    const resolve = getResolver(ext.queryFields.fieldLockBypass);
    const result = await resolve({}, {}, { actor: makeActor([]) }, {} as never);
    expect(result).toEqual({ canBypass: true, reason: "shadow" });
  });

  it("returns no-bypass (no throw) when the context has no actor", async () => {
    const ext = buildLockGraphQLExtension({
      policy: resolveCapLockPolicy({ bypassGroups: ["admin"] }),
    });
    const resolve = getResolver(ext.queryFields.fieldLockBypass);
    // Missing actor + empty context + undefined context — all must be safe.
    expect(await resolve({}, {}, {}, {} as never)).toEqual({ canBypass: false, reason: null });
    expect(await resolve({}, {}, undefined, {} as never)).toEqual({
      canBypass: false,
      reason: null,
    });
  });
});
