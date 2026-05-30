/**
 * Dev-server boot smoke test.
 *
 * Regression guard for the "dev server won't boot" bug:
 *
 *   error: One of the provided types for building the Schema is missing a name.
 *     at new GraphQLSchema(...)
 *     at buildGraphQLSchema(build-schema.ts)
 *     at dev.ts
 *
 * Root cause was `resolveEnvVars` (called by `loadConfig`) deep-rebuilding
 * every object via `{}` + `Object.entries`, which discarded the prototype of
 * the graphql type INSTANCES that cap-chatter carries in
 * `extensions.graphqlExtensions.queryFields` (a `GraphQLNonNull(...)` wrapper).
 * The flattened plain object was no longer a `GraphQLNonNull`, so graphql-js
 * could not unwrap it and `new GraphQLSchema(...)` rejected it as unnamed.
 *
 * Why no existing test caught it: every other build-schema test calls
 * `buildGraphQLSchema` with the SIMPLIFIED shape (1-2 toy entities, no
 * commandLayer / onchangeEvaluator, raw capability objects). The crash only
 * surfaced with dev.ts's FULL assembly run through `loadConfig`'s
 * `resolveEnvVars` pass.
 *
 * This test reproduces dev.ts's boot path EXACTLY and DB-free (InMemoryStore):
 *   1. a representative configured-capability set — `cap-adapter-server` itself,
 *      `cap-chatter` (a PUBLISHED system capability that carries the
 *      `graphqlExtensions` graphql type INSTANCE that is the actual regression
 *      trigger), and an inline SYNTHETIC business capability that contributes
 *      entities + custom actions + a relation + a state machine — so
 *      commandLayer, onchangeEvaluator AND a `graphqlExtensions` graphql type
 *      instance are all exercised;
 *   2. the capabilities flow through `resolveEnvVars` first, mirroring how
 *      `loadConfig` hands them to the assembly (this is the step that broke
 *      the type instances);
 *   3. `assembleDevSchema` — the shared helper that both dev.ts and this test
 *      call — builds the full schema.
 *
 * The synthetic business capability is defined INLINE (rather than pulling in
 * a private demo package) so this PUBLISHED package keeps a clean dependency
 * surface — it never depends on an unpublished `private: true` package.
 *
 * If `resolveEnvVars` ever clobbers graphql type instances again (or any other
 * regression makes a reachable type lose its name), `assembleDevSchema` throws
 * here and CI fails — instead of only `bun run dev:server` failing.
 */

import { describe, expect, it } from "bun:test";
import { capChatter } from "@linchkit/cap-chatter";
import type {
  ActionDefinition,
  CapabilityDefinition,
  EntityDefinition,
  RelationDefinition,
  StateDefinition,
} from "@linchkit/core";
import { defineCapability, defineRelation, resolveEnvVars } from "@linchkit/core";
import {
  GraphQLString,
  getIntrospectionQuery,
  graphqlSync,
  type IntrospectionQuery,
} from "graphql";
import { assembleDevSchema, extractCapabilities } from "../src/assemble-schema";
import { capAdapterServer } from "../src/capability";

// A silent logger so the missing-env warnings emitted by `resolveEnvVars`
// don't spam the test output.
const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ── Synthetic business capability ─────────────────────────────────────────
//
// Stands in for the (private, unpublished) purchase demo. It contributes the
// same breadth so the full entity/action/relation/state path through
// `assembleDevSchema` (commandLayer + onchangeEvaluator) is still exercised:
// two entities (one a relation target), a custom action, a relation, and a
// state machine. Plain `*Definition` shapes from `@linchkit/core` — no `any`.

const projectEntity: EntityDefinition = {
  name: "smoke_project",
  label: "Smoke Project",
  description: "Synthetic project entity for the dev-boot smoke test",
  presentation: {
    titleField: "name",
    badgeField: "status",
    summaryFields: ["owner"],
    icon: "folder",
  },
  fields: {
    name: { type: "string", required: true, label: "Name", ui: { importance: "primary" } },
    owner: { type: "string", label: "Owner", ui: { importance: "primary" } },
    status: {
      type: "state",
      machine: "smoke_project_lifecycle",
      default: "open",
      ui: { importance: "primary", display: "badge" },
    },
  },
};

const milestoneEntity: EntityDefinition = {
  name: "smoke_milestone",
  label: "Smoke Milestone",
  description: "Synthetic milestone entity — the relation target of a project",
  presentation: {
    titleField: "title",
    summaryFields: ["due_at"],
    icon: "flag",
  },
  fields: {
    title: { type: "string", required: true, label: "Title", ui: { importance: "primary" } },
    due_at: { type: "datetime", label: "Due At", ui: { importance: "detail" } },
  },
};

const archiveProjectAction: ActionDefinition = {
  name: "archive_smoke_project",
  entity: "smoke_project",
  label: "Archive Project",
  description: "Custom action that drives the project state machine to archived",
  policy: { mode: "sync", transaction: true },
  exposure: "all",
  stateTransition: { from: "open", to: "archived" },
};

const projectToMilestones: RelationDefinition = defineRelation({
  name: "smoke_project_to_milestones",
  from: "smoke_project",
  to: "smoke_milestone",
  cardinality: "one_to_many",
  fromName: "milestones",
  toName: "project",
  cascade: "delete",
  label: { from: "Milestones", to: "Project" },
});

const projectState: StateDefinition = {
  name: "smoke_project_lifecycle",
  entity: "smoke_project",
  field: "status",
  initial: "open",
  states: ["open", "archived"],
  transitions: [{ from: "open", to: "archived", action: "archive_smoke_project" }],
  meta: {
    open: { label: "Open", color: "green" },
    archived: { label: "Archived", color: "gray" },
  },
};

const capSmokeBusiness: CapabilityDefinition = defineCapability({
  name: "cap-smoke-business",
  label: "Smoke Business",
  description:
    "Synthetic business capability (inline) standing in for the unpublished demo — " +
    "contributes entities + a custom action + a relation + a state machine",
  type: "standard",
  category: "business",
  version: "0.1.0",
  entities: [projectEntity, milestoneEntity],
  actions: [archiveProjectAction],
  states: [projectState],
  relations: [projectToMilestones],
});

/**
 * Representative configured-capability set. Mirrors `config/capabilities.ts`:
 * the adapter itself, a published system capability that contributes a
 * `graphqlExtensions` graphql type instance (cap-chatter), and a synthetic
 * business module that contributes entities + actions + states + relations.
 */
function configuredCapabilities(): CapabilityDefinition[] {
  return [capAdapterServer, capChatter, capSmokeBusiness];
}

describe("dev-server schema boot", () => {
  it("assembles the full GraphQL schema after resolveEnvVars (no DB, no HTTP)", () => {
    // Mirror loadConfig: env-resolve the whole config — INCLUDING capabilities —
    // before assembly. This is the exact step that flattened graphql types.
    const resolved = resolveEnvVars({ capabilities: configuredCapabilities() }, silentLogger) as {
      capabilities: CapabilityDefinition[];
    };

    // Build the schema the SAME WAY dev.ts does: full runtime context with a
    // real commandLayer + onchangeEvaluator + all contributed fields.
    let assembled: ReturnType<typeof assembleDevSchema> | undefined;
    expect(() => {
      assembled = assembleDevSchema(resolved.capabilities);
    }).not.toThrow();

    const schema = assembled?.schema;
    expect(schema).toBeDefined();
    if (!schema) return;

    // Query/Mutation roots exist.
    expect(schema.getQueryType()?.name).toBe("Query");
    expect(schema.getMutationType()?.name).toBe("Mutation");

    // The capability-contributed graphqlExtensions field is wired (this is the
    // field whose graphql type instance the regression destroyed).
    expect(schema.getQueryType()?.getFields().chatterMessages).toBeDefined();
    // ...and the type it references survived with its name intact.
    expect(schema.getTypeMap().ChatterMessageConnection).toBeDefined();
    expect(schema.getTypeMap().ChatterMessage).toBeDefined();

    // Business entities from the synthetic capability are present, proving the
    // full entity/action/relation/state path ran (commandLayer +
    // onchangeEvaluator). The entity must surface in the GraphQL type map too.
    expect(assembled?.allEntities.some((e) => e.name === "smoke_project")).toBe(true);
    expect(schema.getTypeMap().SmokeProject).toBeDefined();

    // No reachable named type in the type map has an empty name (the exact
    // invariant `new GraphQLSchema` enforces).
    for (const [name, type] of Object.entries(schema.getTypeMap())) {
      expect(name.length).toBeGreaterThan(0);
      expect((type as { name: string }).name.length).toBeGreaterThan(0);
    }
  });

  it("exercises commandLayer + onchangeEvaluator in the assembly", () => {
    const assembled = assembleDevSchema(configuredCapabilities());
    // The full production wiring is present — not the simplified test shape.
    expect(assembled.runtime.commandLayer).toBeDefined();
    expect(assembled.onchangeEvaluator).toBeDefined();
    // A dev allow-all permission stub is injected (CommandLayer hard-fails on an
    // empty permission slot), confirming the permission slot is wired.
    expect(assembled.contributions.middlewares.some((m) => m.slot === "permission")).toBe(true);
  });

  it("produces a schema the graphql runtime can EXECUTE, not merely construct", () => {
    // A schema can construct but still be unservable (e.g. a field whose type
    // fails to resolve at execution). Run the standard introspection query — the
    // same one a GraphQL client issues on connect — straight through
    // `graphqlSync`. It exercises every reachable type/field resolver without a
    // DB or HTTP layer; any unresolvable/unnamed type surfaces as a GraphQL
    // error here rather than only at first real request in `dev:server`.
    const { schema } = assembleDevSchema(configuredCapabilities());
    const result = graphqlSync({ schema, source: getIntrospectionQuery() });

    expect(result.errors).toBeUndefined();
    const data = result.data as unknown as IntrospectionQuery;
    expect(data.__schema.queryType.name).toBe("Query");
    // The capability-contributed type the regression destroyed is introspectable.
    expect(data.__schema.types.some((t) => t.name === "ChatterMessageConnection")).toBe(true);
    expect(data.__schema.types.some((t) => t.name === "SmokeProject")).toBe(true);
  });
});

describe("capability contribution merging", () => {
  // Build a minimal capability that contributes a single root query field, so
  // two of them collide on the same field name.
  function capWithQueryField(name: string, field: string): CapabilityDefinition {
    return defineCapability({
      name,
      label: name,
      description: `Synthetic capability contributing query field "${field}"`,
      type: "standard",
      category: "business",
      version: "0.1.0",
      extensions: {
        graphqlExtensions: {
          queryFields: {
            [field]: { type: GraphQLString, resolve: () => "ok" },
          },
        },
      },
    });
  }

  it("throws (does not silently overwrite) on a duplicate root query field", () => {
    const a = capWithQueryField("cap-collide-a", "duplicatedField");
    const b = capWithQueryField("cap-collide-b", "duplicatedField");
    expect(() => extractCapabilities([a, b])).toThrow(
      /Duplicate GraphQL query field "duplicatedField"/,
    );
  });

  it("allows distinct query fields from different capabilities", () => {
    const a = capWithQueryField("cap-distinct-a", "fieldA");
    const b = capWithQueryField("cap-distinct-b", "fieldB");
    const contributions = extractCapabilities([a, b]);
    expect(contributions.extraQueryFields.fieldA).toBeDefined();
    expect(contributions.extraQueryFields.fieldB).toBeDefined();
  });
});
