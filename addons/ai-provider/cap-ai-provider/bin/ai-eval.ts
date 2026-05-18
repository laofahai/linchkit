#!/usr/bin/env bun
/**
 * Thin entry script: dispatches `bun run ai:eval` argv into the devtools
 * runCli. Lives here (not in devtools) because devtools must remain
 * decoupled from the AI service implementation AND from the intent
 * scenario adapter — both ship from cap-ai-provider, so this script is
 * the natural seam where the AIService, ontology, and scenario adapter
 * meet.
 *
 * Mirrors the dev:server / dev:ui split convention in the repo root.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ActionDefinition, FieldDefinition } from "@linchkit/core";
import {
  type CliDeps,
  type InlineCatalogAction,
  runCli,
  type ScenarioRegistry,
} from "@linchkit/devtools";
import { createAIService, defaultAIConfig } from "../src/ai-service";
import { createIntentScenario } from "../src/eval/intent-scenario";
import type { OntologyRegistryLike } from "../src/intent-resolver";

const CATALOGS_DIR = path.resolve(import.meta.dir, "..", "__tests__", "eval", "catalogs");

/**
 * Disk-backed inline catalog reader. The CLI also has a fallback loader,
 * but we explicitly inject one here so the addon entry has a single place
 * controlling catalog resolution.
 */
async function loadCatalogFile(name: string): Promise<ReadonlyArray<InlineCatalogAction>> {
  const file = path.join(CATALOGS_DIR, `${name}.json`);
  const raw = await readFile(file, "utf8");
  const parsed = JSON.parse(raw) as { actions?: unknown };
  if (!Array.isArray(parsed.actions)) {
    throw new Error(`catalog ${file} missing "actions" array`);
  }
  return parsed.actions as ReadonlyArray<InlineCatalogAction>;
}

/**
 * Build a minimal production-shape OntologyRegistryLike from
 * `purchase_management.json`. The intent scenario routes `demo:*`
 * catalog sources through `deps.ontology`; without booting
 * cap-purchase-demo, this stub mirrors that capability's three real
 * actions so fixtures referencing `demo:purchase_management` resolve.
 *
 * Coerce inline-catalog entries to `ActionDefinition` here once so the
 * cast doesn't leak into the scenario adapter — the resolver only reads
 * the structurally compatible fields (name/entity/label/description/input).
 */
async function buildOntology(): Promise<OntologyRegistryLike> {
  const actions = await loadCatalogFile("purchase_management");
  const byEntity = new Map<string, ActionDefinition[]>();
  for (const a of actions) {
    const def: ActionDefinition = {
      name: a.name,
      entity: a.entity,
      label: a.label,
      description: a.description,
      input: a.input as unknown as Record<string, FieldDefinition> | undefined,
      policy: { mode: "sync", transaction: false },
    };
    const list = byEntity.get(a.entity) ?? [];
    list.push(def);
    byEntity.set(a.entity, list);
  }
  return {
    listEntities: () => Array.from(byEntity.keys()),
    actionsFor: (entityName) => byEntity.get(entityName) ?? [],
  };
}

const cliDeps: CliDeps = {
  registerScenarios: (registry: ScenarioRegistry) => {
    registry.register("intent", createIntentScenario());
  },
  loadLiveDeps: async ({ model }) => {
    const ai = createAIService(defaultAIConfig);
    const ontology = await buildOntology();
    return { ai, ontology, loadInlineCatalog: loadCatalogFile, model };
  },
};

async function main(): Promise<void> {
  const result = await runCli(process.argv.slice(2), cliDeps);
  process.exit(result.exitCode);
}

main().catch((e) => {
  // Bubble unexpected errors (the CLI swallows everything it can — anything
  // here is a true bootstrap failure).
  process.stderr.write(`${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
