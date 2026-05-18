#!/usr/bin/env bun
/**
 * Thin entry script: dispatches `bun run ai:eval` argv into the devtools
 * runCli. Lives here (not in devtools) because devtools must remain
 * decoupled from the AI service implementation — this script owns the
 * cap-ai-provider-flavoured AIService + ontology bootstrap.
 *
 * Mirrors the dev:server / dev:ui split convention in the repo root.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type CliDeps,
  type InlineCatalogAction,
  type OntologyRegistryLike,
  runCli,
} from "@linchkit/devtools";
import { createAIService, defaultAIConfig } from "../src/index.js";

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
 * Build a minimal OntologyRegistryLike from `purchase_management.json`.
 * The intent scenario routes `demo:*` catalog sources through ontology
 * — without booting cap-purchase-demo, this stub mirrors that capability's
 * three actions so the eval fixtures referencing `demo:purchase_management`
 * resolve correctly.
 */
async function buildOntology(): Promise<OntologyRegistryLike> {
  const actions = await loadCatalogFile("purchase_management");
  const entityIndex = new Map<string, InlineCatalogAction[]>();
  for (const a of actions) {
    const list = entityIndex.get(a.entity);
    if (list) list.push(a);
    else entityIndex.set(a.entity, [a]);
  }
  return {
    listEntities: () => Array.from(entityIndex.keys()),
    actionsFor: (entityName) => entityIndex.get(entityName) ?? [],
  };
}

const cliDeps: CliDeps = {
  loadLiveDeps: async () => {
    const ai = createAIService(defaultAIConfig);
    const ontology = await buildOntology();
    return { ai, ontology, loadInlineCatalog: loadCatalogFile };
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
