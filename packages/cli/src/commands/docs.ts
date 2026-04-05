/**
 * linch docs — Documentation generation commands
 *
 * Subcommands:
 *   generate  — Generate Markdown API documentation from the ontology
 *   openapi   — Generate OpenAPI 3.0 specification
 *   validate  — Validate documentation completeness
 *   show      — Show capability spec documentation
 *   search    — Search across all documentation
 */

import { writeFileSync } from "node:fs";
import type {
  ActionDefinition,
  CapabilityDefinition,
  EntityDefinition,
  LinchKitConfig,
  RelationDefinition,
  RuleDefinition,
  StateDefinition,
  ViewDefinition,
} from "@linchkit/core";
import {
  ActionRegistry,
  convertEntityRelationshipFieldsToImplicitRelations,
  createOntologyRegistry,
  createRelationRegistry,
  EntityRegistry,
} from "@linchkit/core/server";
import {
  createDocSearchIndex,
  generateApiDoc,
  generateCapabilityDoc,
  generateOpenAPISpec,
  renderCapabilityDoc,
  renderSystemDoc,
} from "@linchkit/devtools/documentation";
import { validateActionDoc, validateEntityDoc } from "@linchkit/devtools/governance";
import { defineCommand } from "citty";
import { loadConfig } from "../utils/load-config";

// ── Helpers ──────────────────────────────────

/** Load config and extract capability definitions */
async function loadCapabilities(): Promise<{
  config: LinchKitConfig;
  capabilities: CapabilityDefinition[];
}> {
  let config: LinchKitConfig;
  try {
    const result = await loadConfig();
    config = result.config;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Config file not found")) {
      console.error(
        "[linch] No linchkit.config.ts found. Are you in a LinchKit project directory?",
      );
      console.error("[linch] Run 'linch init' to create a new project.");
    } else {
      console.error(`[linch] Failed to load config: ${msg}`);
    }
    process.exit(1);
  }

  const capabilities = (config.capabilities ?? []) as CapabilityDefinition[];
  return { config, capabilities };
}

/**
 * Build a lightweight OntologyRegistry from capabilities.
 * Only constructs Schema, Action, and Link registries (no DB, no event bus).
 */
function buildOntologyFromCapabilities(capabilities: CapabilityDefinition[]) {
  const entities: EntityDefinition[] = [];
  const actions: ActionDefinition[] = [];
  const views: ViewDefinition[] = [];
  const states: StateDefinition[] = [];
  const links: RelationDefinition[] = [];
  const rules: RuleDefinition[] = [];

  for (const cap of capabilities) {
    if (cap.entities) entities.push(...cap.entities);
    if (cap.actions) actions.push(...cap.actions);
    if (cap.views) views.push(...cap.views);
    if (cap.states) states.push(...cap.states);
    if (cap.relations) links.push(...cap.relations);
    if (cap.rules) rules.push(...cap.rules);
  }

  // Auto-promote relationship fields to implicit links
  const { implicitLinks } = convertEntityRelationshipFieldsToImplicitRelations(entities, links);
  links.push(...implicitLinks);

  // Build registries
  const entityRegistry = new EntityRegistry();
  for (const entity of entities) {
    entityRegistry.register(entity);
  }

  const relationRegistry = createRelationRegistry();
  for (const relation of links) {
    relationRegistry.register(relation);
  }

  const actionRegistry = new ActionRegistry();
  for (const action of actions) {
    if (!actionRegistry.has(action.name)) {
      actionRegistry.register(action);
    }
  }

  const ontology = createOntologyRegistry({
    schemas: entityRegistry,
    actions: actionRegistry,
    rules,
    states,
    views,
    links: relationRegistry,
  });

  return { ontology, entities, actions };
}

/** Write content to a file or stdout */
function output(content: string, filePath?: string): void {
  if (filePath) {
    writeFileSync(filePath, content, "utf-8");
    console.log(`[linch] Written to ${filePath}`);
  } else {
    process.stdout.write(content);
  }
}

// ── Subcommands ──────────────────────────────

const generateCommand = defineCommand({
  meta: {
    name: "generate",
    description: "Generate Markdown API documentation for all schemas and actions",
  },
  args: {
    output: {
      type: "string",
      description: "Output file path (default: stdout)",
    },
    title: {
      type: "string",
      description: "Documentation title",
      default: "API Documentation",
    },
  },
  async run({ args }) {
    const { capabilities } = await loadCapabilities();
    const { ontology } = buildOntologyFromCapabilities(capabilities);

    const systemDoc = generateApiDoc(ontology, {
      title: args.title as string,
    });
    const markdown = renderSystemDoc(systemDoc);

    output(markdown, args.output as string | undefined);
  },
});

const openapiCommand = defineCommand({
  meta: {
    name: "openapi",
    description: "Generate OpenAPI 3.0 specification",
  },
  args: {
    output: {
      type: "string",
      description: "Output file path (default: stdout)",
    },
    title: {
      type: "string",
      description: "API title",
      default: "LinchKit API",
    },
    version: {
      type: "string",
      description: "API version",
      default: "1.0.0",
    },
  },
  async run({ args }) {
    const { capabilities } = await loadCapabilities();
    const { ontology } = buildOntologyFromCapabilities(capabilities);

    const systemDoc = generateApiDoc(ontology, {
      title: args.title as string,
    });
    const spec = generateOpenAPISpec(systemDoc, {
      version: args.version as string,
    });
    const json = JSON.stringify(spec, null, 2);

    output(json, args.output as string | undefined);
  },
});

const validateCommand = defineCommand({
  meta: {
    name: "validate",
    description: "Validate documentation completeness across schemas and actions",
  },
  args: {
    json: {
      type: "boolean",
      description: "Output as JSON",
      default: false,
    },
  },
  async run({ args }) {
    const { capabilities } = await loadCapabilities();
    const { entities, actions } = buildOntologyFromCapabilities(capabilities);

    const schemaResults = entities.map(validateEntityDoc);
    const actionResults = actions.map(validateActionDoc);
    const allResults = [...schemaResults, ...actionResults];

    // Overall coverage
    const totalItems = allResults.reduce((sum, r) => sum + r.totalItems, 0);
    const documentedItems = allResults.reduce((sum, r) => sum + r.documentedItems, 0);
    const overallCoverage =
      totalItems === 0 ? 100 : Math.round((documentedItems / totalItems) * 100);

    if (args.json) {
      console.log(
        JSON.stringify(
          {
            overallCoverage,
            totalItems,
            documentedItems,
            results: allResults,
          },
          null,
          2,
        ),
      );
      return;
    }

    // Human-readable output
    console.log("");
    console.log("  Documentation Completeness Report");
    console.log("  ==================================");
    console.log("");
    console.log(`  Overall coverage: ${overallCoverage}% (${documentedItems}/${totalItems} items)`);
    console.log("");

    // Schema results
    if (schemaResults.length > 0) {
      console.log("  Schemas:");
      for (const r of schemaResults) {
        const icon = r.coverage === 100 ? "OK" : "!!";
        console.log(
          `    [${icon}] ${r.name}: ${r.coverage}% (${r.documentedItems}/${r.totalItems})`,
        );
        for (const issue of r.issues) {
          console.log(`         ${issue.severity.toUpperCase()}: ${issue.message}`);
        }
      }
      console.log("");
    }

    // Action results
    if (actionResults.length > 0) {
      console.log("  Actions:");
      for (const r of actionResults) {
        const icon = r.coverage === 100 ? "OK" : "!!";
        console.log(
          `    [${icon}] ${r.name}: ${r.coverage}% (${r.documentedItems}/${r.totalItems})`,
        );
        for (const issue of r.issues) {
          console.log(`         ${issue.severity.toUpperCase()}: ${issue.message}`);
        }
      }
      console.log("");
    }

    // Exit with error if coverage is below 100%
    if (overallCoverage < 100) {
      const issueCount = allResults.reduce((sum, r) => sum + r.issues.length, 0);
      console.log(`  Found ${issueCount} documentation issue(s).`);
      console.log("");
      process.exit(1);
    }
  },
});

const showCommand = defineCommand({
  meta: {
    name: "show",
    description: "Show capability spec documentation",
  },
  args: {
    name: {
      type: "positional",
      description: "Capability name",
      required: true,
    },
    output: {
      type: "string",
      description: "Output file path (default: stdout)",
    },
    json: {
      type: "boolean",
      description: "Output as JSON instead of Markdown",
      default: false,
    },
  },
  async run({ args }) {
    const { capabilities } = await loadCapabilities();

    const cap = capabilities.find((c) => c.name === args.name);
    if (!cap) {
      console.error(`[linch] Capability "${args.name}" not found.`);
      console.error(
        `[linch] Available capabilities: ${capabilities.map((c) => c.name).join(", ") || "(none)"}`,
      );
      process.exit(1);
    }

    const doc = generateCapabilityDoc(cap);

    if (args.json) {
      output(JSON.stringify(doc, null, 2), args.output as string | undefined);
    } else {
      const markdown = renderCapabilityDoc(doc);
      output(markdown, args.output as string | undefined);
    }
  },
});

const searchCommand = defineCommand({
  meta: {
    name: "search",
    description: "Search across all documentation by keyword",
  },
  args: {
    query: {
      type: "positional",
      description: "Search query",
      required: true,
    },
    type: {
      type: "string",
      description:
        "Filter by type (capability, schema, action, rule, state_machine, view, relation)",
    },
    capability: {
      type: "string",
      description: "Filter by capability name",
    },
    limit: {
      type: "string",
      description: "Maximum number of results",
      default: "20",
    },
    json: {
      type: "boolean",
      description: "Output as JSON",
      default: false,
    },
  },
  async run({ args }) {
    const { capabilities } = await loadCapabilities();
    const index = createDocSearchIndex(capabilities);

    const results = index.search(args.query as string, {
      type: args.type as DocSearchResult["type"] | undefined,
      capability: args.capability as string | undefined,
      limit: Number.parseInt(args.limit as string, 10) || 20,
    });

    if (args.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    if (results.length === 0) {
      console.log(`  No results found for "${args.query}".`);
      return;
    }

    console.log("");
    console.log(`  Search results for "${args.query}" (${results.length} found):`);
    console.log(`  ${"=".repeat(50)}`);
    console.log("");

    for (const r of results) {
      const typeTag = `[${r.type}]`.padEnd(16);
      console.log(`  ${typeTag} ${r.name}`);
      if (r.description) {
        console.log(`                  ${r.description}`);
      }
      console.log(`                  capability: ${r.capability} | score: ${r.score}`);
      console.log("");
    }
  },
});

// Import DocSearchResult type for the search command arg typing
type DocSearchResult = import("@linchkit/devtools/documentation").DocSearchResult;

// ── Main command ──────────────────────────────

export const docsCommand = defineCommand({
  meta: {
    name: "docs",
    description: "Generate, view, and search API documentation",
  },
  subCommands: {
    generate: generateCommand,
    openapi: openapiCommand,
    validate: validateCommand,
    show: showCommand,
    search: searchCommand,
  },
});
