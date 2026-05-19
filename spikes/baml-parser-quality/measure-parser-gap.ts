#!/usr/bin/env bun
/**
 * Spec 69 Phase 2b — JSON-quality measurement (one-shot, NOT a kept artifact).
 *
 * Calls BAML's b.ResolveIntent once per intent fixture with a Collector
 * attached so we can compare:
 *   (1) BAML's Schema-Aligned Parser (SAP) verdict
 *   (2) What stdlib `JSON.parse` would have done on the same raw bytes
 *
 * The whole point of the spike is to put a number on the SAP claim: if
 * stdlib JSON.parse fails on N/36 raw responses but SAP succeeds, that's
 * the parser-failure-rate reduction. Otherwise the model is reliable
 * enough at this task that BAML buys us nothing on the parser axis.
 *
 * Usage:
 *   AI_EVAL_LIVE=1 bun --env-file=.env spikes/baml-parser-quality/measure-parser-gap.ts
 *
 * NOTE: this script is intentionally outside the package surface
 * (`__tests__/`, `src/`, `eval-runner/`) so it neither ships with the
 * addon nor pollutes the eval framework. Delete after the spike report.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Collector } from "@boundaryml/baml";
import { b as bamlClient } from "../../addons/ai-provider/cap-ai-provider/baml_client";
import {
  ALTERNATIVES_CONFIDENCE_THRESHOLD,
  MAX_ALTERNATIVES,
} from "../../addons/ai-provider/cap-ai-provider/src/intent-resolver";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const FIXTURES_DIR = path.join(
  REPO_ROOT,
  "addons/ai-provider/cap-ai-provider/__tests__/eval/fixtures/intent",
);
const CATALOGS_DIR = path.join(
  REPO_ROOT,
  "addons/ai-provider/cap-ai-provider/__tests__/eval/catalogs",
);

interface Fixture {
  id: string;
  input: { userMessage: string };
  context: { catalogSource: string; scope?: { entityFilter?: string[]; actionFilter?: string[] } };
}

interface CatalogEntry {
  name: string;
  entity: string;
  label: string;
  description?: string;
  inputFields: Array<{
    name: string;
    type: string;
    required: boolean;
    label?: string;
    description?: string;
    allowEmpty?: boolean;
  }>;
}

function sanitizeText(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional
  return value.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");
}

function toCatalogEntry(raw: any): CatalogEntry {
  const inputFields: CatalogEntry["inputFields"] = [];
  if (raw.input) {
    for (const [name, f] of Object.entries<any>(raw.input)) {
      inputFields.push({
        name,
        type: f.type,
        required: f.required === true,
        label: f.label,
        description: f.description,
        allowEmpty: f.allowEmpty === true ? true : undefined,
      });
    }
  }
  return {
    name: raw.name,
    entity: raw.entity,
    label: raw.label,
    description: raw.description,
    inputFields,
  };
}

function serializeCatalogForPrompt(catalog: CatalogEntry[]): string {
  if (catalog.length === 0) {
    return "[] // no actions available in current scope";
  }
  const safe = catalog.map((a) => ({
    name: a.name,
    entity: a.entity,
    label: sanitizeText(a.label),
    description: a.description ? sanitizeText(a.description) : undefined,
    inputFields: a.inputFields.map((f) => ({
      name: f.name,
      type: f.type,
      required: f.required,
      ...(f.allowEmpty === true ? { allowEmpty: true } : {}),
      label: f.label ? sanitizeText(f.label) : undefined,
      description: f.description ? sanitizeText(f.description) : undefined,
    })),
  }));
  return JSON.stringify(safe, null, 2);
}

async function loadCatalog(name: string): Promise<CatalogEntry[]> {
  const raw = await readFile(path.join(CATALOGS_DIR, `${name}.json`), "utf8");
  const parsed = JSON.parse(raw) as { actions: any[] };
  return parsed.actions.map(toCatalogEntry);
}

async function loadAllFixtures(): Promise<Fixture[]> {
  const out: Fixture[] = [];
  for (const sub of await readdir(FIXTURES_DIR, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    const subDir = path.join(FIXTURES_DIR, sub.name);
    for (const file of await readdir(subDir)) {
      if (!file.endsWith(".json")) continue;
      const raw = await readFile(path.join(subDir, file), "utf8");
      out.push(JSON.parse(raw) as Fixture);
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * Mirror the production extractFirstJsonObject + JSON.parse pipeline so
 * the comparison is fair: SAP only "wins" on inputs that the production
 * extractor genuinely couldn't recover. A purely-stdlib JSON.parse check
 * would over-report SAP wins.
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (ch === "\\") {
        escapeNext = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
      if (depth < 0) return null;
    }
  }
  return null;
}

function productionParse(raw: string): { ok: boolean; reason?: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1]
    ? fenced[1].trim()
    : trimmed.startsWith("{") && trimmed.endsWith("}")
      ? trimmed
      : (extractFirstJsonObject(trimmed) ?? null);
  if (!candidate) return { ok: false, reason: "no JSON object found" };
  try {
    JSON.parse(candidate);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `JSON.parse: ${(e as Error).message}` };
  }
}

async function main(): Promise<void> {
  const fixtures = await loadAllFixtures();
  // eslint-disable-next-line no-console
  console.log(`Loaded ${fixtures.length} fixtures`);

  let bamlOk = 0;
  let bamlFail = 0;
  let prodOk = 0;
  let prodFail = 0;
  let sapRescued = 0; // BAML succeeded where stdlib production parser would have failed
  let bamlValidationErrors = 0;

  for (const fx of fixtures) {
    const source = fx.context.catalogSource;
    if (!source.startsWith("inline:") && !source.startsWith("demo:")) {
      // eslint-disable-next-line no-console
      console.log(`SKIP ${fx.id}: unsupported catalogSource ${source}`);
      continue;
    }
    const catalogName = source.startsWith("inline:")
      ? source.slice("inline:".length)
      : "purchase_management";
    const catalog = await loadCatalog(catalogName);

    const scope = fx.context.scope;
    const entityFilter = scope?.entityFilter && new Set(scope.entityFilter);
    const actionFilter = scope?.actionFilter && new Set(scope.actionFilter);
    const filtered = catalog.filter((c) => {
      if (entityFilter && !entityFilter.has(c.entity)) return false;
      if (actionFilter && !actionFilter.has(c.name)) return false;
      return true;
    });

    const userMessage = fx.input.userMessage.trim();
    if (userMessage.length === 0) {
      // eslint-disable-next-line no-console
      console.log(`${fx.id}: empty prompt skipped`);
      continue;
    }

    const collector = new Collector(`fx-${fx.id}`);
    let bamlSucceeded = false;
    try {
      await bamlClient.ResolveIntent(
        serializeCatalogForPrompt(filtered),
        userMessage,
        ALTERNATIVES_CONFIDENCE_THRESHOLD,
        MAX_ALTERNATIVES,
        { collector },
      );
      bamlSucceeded = true;
      bamlOk++;
    } catch (e) {
      bamlFail++;
      const name = (e as Error)?.name ?? "Error";
      if (name === "BamlValidationError") bamlValidationErrors++;
      // eslint-disable-next-line no-console
      console.log(`  ${fx.id}: BAML throw ${name}: ${(e as Error).message.slice(0, 200)}`);
    }

    const rawResp = collector.last?.rawLlmResponse ?? null;
    if (rawResp == null) {
      // eslint-disable-next-line no-console
      console.log(`  ${fx.id}: no rawLlmResponse captured`);
      continue;
    }
    const prod = productionParse(rawResp);
    if (prod.ok) prodOk++;
    else prodFail++;
    if (bamlSucceeded && !prod.ok) {
      sapRescued++;
      // eslint-disable-next-line no-console
      console.log(`  SAP RESCUE on ${fx.id}: ${prod.reason}`);
      // eslint-disable-next-line no-console
      console.log(`    raw[0..240]: ${rawResp.slice(0, 240).replace(/\n/g, "\\n")}`);
    }
  }

  // eslint-disable-next-line no-console
  console.log("\n=== Summary ===");
  // eslint-disable-next-line no-console
  console.log(
    `BAML SAP parse: ok=${bamlOk}, fail=${bamlFail} (BamlValidationError=${bamlValidationErrors})`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `Production parser (extractFirstJsonObject + JSON.parse): ok=${prodOk}, fail=${prodFail}`,
  );
  // eslint-disable-next-line no-console
  console.log(`SAP rescues (BAML ok && prod parser would have failed): ${sapRescued}`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
