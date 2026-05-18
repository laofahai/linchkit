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

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  ActionDefinition,
  AIServiceConfig,
  FieldDefinition,
  LinchKitConfig,
} from "@linchkit/core";
import { resolveEnvVars } from "@linchkit/core";
import {
  type CliDeps,
  type InlineCatalogAction,
  runCli,
  type ScenarioRegistry,
} from "@linchkit/devtools";
import { createIntentScenario } from "../eval-runner/intent-scenario";
import { createAIService, defaultAIConfig } from "../src/ai-service";
import type { OntologyRegistryLike } from "../src/intent-resolver";

/**
 * Load the repo-level AI provider config from `config/linchkit.config.ts`
 * so the eval CLI uses the same provider/model the running server uses
 * (e.g. zhipu GLM by default in this repo). Falls back to the
 * package-level `defaultAIConfig` only when no project config is present.
 *
 * Why this matters: previously bin/ai-eval.ts hardcoded `defaultAIConfig`
 * (anthropic-only), which silently ignored the project's `defaultProvider`
 * choice and forced operators to supply an ANTHROPIC_API_KEY even when
 * the rest of the system was wired to a different provider.
 */
async function loadRepoAIConfig(): Promise<AIServiceConfig | undefined> {
  const configPath = path.resolve(process.cwd(), "config", "linchkit.config.ts");
  if (!existsSync(configPath)) {
    return undefined;
  }
  const mod = (await import(configPath)) as { default?: LinchKitConfig };
  const cfg = mod.default;
  if (!cfg?.ai) {
    return undefined;
  }
  return resolveEnvVars(cfg.ai) as AIServiceConfig;
}

/**
 * Fallback catalog root — only used if the CLI somehow passes an
 * undefined `catalogsDir` to loadLiveDeps (the CLI always defaults it,
 * so this is defensive). Honors --catalogs-dir overrides automatically
 * because the CLI provides the resolved path in the loadLiveDeps ctx.
 */
const DEFAULT_CATALOGS_DIR = path.resolve(import.meta.dir, "..", "__tests__", "eval", "catalogs");

/**
 * Disk-backed inline catalog reader factory. Bound to a specific
 * catalogs root so the same closure can be re-used for both the inline
 * loader injected into scenario deps AND the buildOntology call below
 * — both must honor `--catalogs-dir`.
 */
function makeCatalogReader(
  catalogsDir: string,
): (name: string) => Promise<ReadonlyArray<InlineCatalogAction>> {
  return async (name: string) => {
    const file = path.join(catalogsDir, `${name}.json`);
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { actions?: unknown };
    if (!Array.isArray(parsed.actions)) {
      throw new Error(`catalog ${file} missing "actions" array`);
    }
    return parsed.actions as ReadonlyArray<InlineCatalogAction>;
  };
}

/**
 * Build a minimal production-shape OntologyRegistryLike from
 * `purchase_management.json` resolved relative to the supplied
 * `catalogsDir`. The intent scenario routes `demo:*` catalog sources
 * through `deps.ontology`; without booting cap-purchase-demo, this stub
 * mirrors that capability's three real actions so fixtures referencing
 * `demo:purchase_management` resolve.
 *
 * Coerce inline-catalog entries to `ActionDefinition` here once so the
 * cast doesn't leak into the scenario adapter — the resolver only reads
 * the structurally compatible fields (name/entity/label/description/input).
 */
async function buildOntology(catalogsDir: string): Promise<OntologyRegistryLike> {
  const reader = makeCatalogReader(catalogsDir);
  const actions = await reader("purchase_management");
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
  loadLiveDeps: async ({ catalogsDir, model }) => {
    // Honor the CLI's --catalogs-dir override for BOTH the inline loader
    // AND buildOntology — previously buildOntology used a hardcoded path
    // which silently ignored the flag.
    const resolvedCatalogsDir = catalogsDir ?? DEFAULT_CATALOGS_DIR;
    const aiConfig = (await loadRepoAIConfig()) ?? defaultAIConfig;
    const ai = createAIService(aiConfig);
    const ontology = await buildOntology(resolvedCatalogsDir);
    // Report the effective provider + default model so the CLI can stamp
    // them onto the baseline + report (otherwise the markdown shows
    // "Model: n/a / Provider: n/a"). Explicit --model on the CLI still
    // overrides our reported `modelId`.
    const providerName = aiConfig.defaultProvider;
    const reportedModelId = aiConfig.providers[providerName]?.defaultModel;
    return {
      ai,
      ontology,
      loadInlineCatalog: makeCatalogReader(resolvedCatalogsDir),
      model,
      modelId: reportedModelId,
      providerName,
    };
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
