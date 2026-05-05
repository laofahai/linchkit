/**
 * linch exec — Run a registered Action with input + optional ExecutionMeta.
 *
 * Spec 65 §3.5. Boots a minimal in-process LinchKit runtime (CommandLayer
 * + ActionExecutor + DataProvider + tenant/permission middleware) and
 * dispatches the named action through the same pipeline that REST / GraphQL
 * / MCP transports use. No transport startup, no flow engine, no AI service —
 * exec is a one-shot CLI invocation, not a long-running process.
 *
 * Exit codes (Spec 65 §3.5):
 *   0 — action returned success
 *   1 — input/meta parsing or argument validation error
 *   2 — action execution returned failure (or threw)
 */

import { readFileSync } from "node:fs";
import type { ActionResult, Actor, CapabilityDefinition, LinchKitConfig } from "@linchkit/core";
import { ConfigRegistry, DEFAULT_META_MAX_BYTES, initI18n } from "@linchkit/core";
import {
  type CommandLayer,
  consoleLogger,
  createActionExecutor,
  createApprovalVerifier,
  createCommandLayer,
  createEventBus,
  detectEnvironment,
  InMemoryApprovalStore,
  InMemoryExecutionLogger,
} from "@linchkit/core/server";
import { defineCommand } from "citty";
import { loadConfig } from "../utils/load-config";
import { buildRegistries, wireAuthProvider } from "./startup/build-registries";
import { collectCapabilityDefinitions } from "./startup/collect-capabilities";
import { setupDatabase } from "./startup/setup-database";

// ── Helpers ─────────────────────────────────────────────────

/**
 * Drop `_`-prefixed keys from a record. Spec 65 §4.4 — external CLI callers
 * cannot set system meta keys; the action engine also strips, but doing it
 * pre-flight keeps the 8 KB size check honest about what will be sent over
 * the wire.
 */
function stripSystemKeys(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (k.startsWith("_")) continue;
    out[k] = v;
  }
  return out;
}

// ── Argument parsing helpers ────────────────────────────────

/**
 * Parse a JSON string. Throws a structured error suitable for stderr.
 * `--input`/`--meta` always wrap user-supplied JSON; quote/escape mistakes
 * are common, so the error needs the source label and the parser message.
 */
function parseJsonArg(label: string, raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON for ${label}: ${msg}`);
  }
}

/** Read a JSON file. Errors are tagged with the flag they came from. */
function readJsonFile(label: string, path: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read ${label} file "${path}": ${msg}`);
  }
  return parseJsonArg(label, raw);
}

// ── Bootstrap helpers ───────────────────────────────────────

/**
 * Build a minimal CommandLayer + executor in-process. Mirrors dev-wiring's
 * registries and middleware setup but skips transport/flow/AI/cache
 * machinery — exec only needs to dispatch one action and exit.
 */
async function bootstrapCommandLayer(): Promise<{
  commandLayer: CommandLayer;
  shutdown: () => Promise<void>;
}> {
  // Suppress runtime logger output so the CLI's stdout stays clean for the
  // action result. CLI output (including errors) is emitted via console below.
  process.env.LOG_LEVEL ??= "silent";

  const environment = detectEnvironment();

  let config: LinchKitConfig = {};
  try {
    const result = await loadConfig();
    config = result.config;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("Config file not found:")) {
      throw new Error("No linchkit.config.ts found. Run from a LinchKit project directory.");
    }
    throw new Error(`Failed to load config: ${msg}`);
  }

  const capabilities = (config.capabilities ?? []) as CapabilityDefinition[];
  const registry = ConfigRegistry.create(config, capabilities);

  await initI18n();

  const collected = collectCapabilityDefinitions(capabilities);
  const { entities, actions, links, middlewares, interfaces } = collected;

  const { entityRegistry, actionRegistry } = await buildRegistries({
    capabilities,
    interfaces,
    schemas: entities,
    actions,
    links,
    middlewares,
    registry,
    environment,
  });

  const { dataProvider, dbInstance } = await setupDatabase({
    registry,
    schemas: entities,
    links,
  });

  await wireAuthProvider({
    capabilities,
    actionRegistry,
    actions,
    middlewares,
    dataProvider,
    registry,
    usingDatabase: dbInstance !== undefined,
    dbInstance,
  });

  const executionLogger = new InMemoryExecutionLogger();
  const approvalStore = new InMemoryApprovalStore();
  const { bus: eventBus } = createEventBus();
  const capabilityNames = new Set(capabilities.map((c) => c.name));

  const executor = createActionExecutor({
    dataProvider,
    executionLogger,
    configRegistry: registry,
    eventBus,
    capabilityNames,
    entityRegistry,
    logger: consoleLogger,
  });
  for (const action of actionRegistry.getAll()) {
    executor.registry.register(action);
  }

  const commandLayer = createCommandLayer({
    executor,
    verifyApproval: createApprovalVerifier(approvalStore),
  });
  for (const mw of middlewares) {
    commandLayer.use(mw);
  }

  const shutdown = async (): Promise<void> => {
    if (dbInstance) {
      const { closeDatabase } = await import("@linchkit/core/server");
      await closeDatabase();
    }
  };

  return { commandLayer, shutdown };
}

// ── Command definition ──────────────────────────────────────

export const execCommand = defineCommand({
  meta: {
    name: "exec",
    description: "Run a registered Action with input and optional ExecutionMeta",
  },
  args: {
    action: {
      type: "positional",
      description: "Action name to execute (verb_noun, e.g. submit_request)",
      required: true,
    },
    input: {
      type: "string",
      description: "JSON string for action input (default: {})",
    },
    "input-file": {
      type: "string",
      description: "Read action input JSON from a file (mutually exclusive with --input)",
    },
    meta: {
      type: "string",
      description: "JSON string for ExecutionMeta (system keys with leading _ are stripped)",
    },
    "meta-file": {
      type: "string",
      description: "Read ExecutionMeta JSON from a file (mutually exclusive with --meta)",
    },
    actor: {
      type: "string",
      description: "Actor ID for the call (default: cli system actor)",
    },
    tenant: {
      type: "string",
      description: "Tenant ID (optional)",
    },
    json: {
      type: "boolean",
      description: "Output result as compact JSON",
      default: false,
    },
  },
  async run({ args }) {
    const actionName = args.action as string;
    const outputJson = args.json as boolean;

    // 1. Mutually-exclusive flag validation — surface before doing any work.
    if (args.input !== undefined && args["input-file"] !== undefined) {
      console.error("Error: --input and --input-file are mutually exclusive");
      process.exit(1);
    }
    if (args.meta !== undefined && args["meta-file"] !== undefined) {
      console.error("Error: --meta and --meta-file are mutually exclusive");
      process.exit(1);
    }

    // 2. Parse input + meta JSON. Failures here are user errors → exit 1.
    let input: Record<string, unknown>;
    let rawMeta: Record<string, unknown> | undefined;
    try {
      if (args["input-file"] !== undefined) {
        input = readJsonFile("--input-file", args["input-file"] as string);
      } else if (args.input !== undefined) {
        input = parseJsonArg("--input", args.input as string);
      } else {
        input = {};
      }

      if (args["meta-file"] !== undefined) {
        rawMeta = readJsonFile("--meta-file", args["meta-file"] as string);
      } else if (args.meta !== undefined) {
        rawMeta = parseJsonArg("--meta", args.meta as string);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }

    // 3. Strip `_`-prefixed keys (Spec 65 §4.4) — external callers must not
    // set system meta keys. The action engine also strips, but doing it here
    // keeps the size check below honest about the wire payload.
    const meta = rawMeta !== undefined ? stripSystemKeys(rawMeta) : undefined;

    // 4. Pre-flight 8 KB size enforcement (Spec 65 §10.2). The CommandLayer
    // would also reject oversize meta, but failing fast here gives the user
    // a clearer "validation error" exit code (1) instead of "execution
    // failure" (2).
    if (meta !== undefined) {
      const serialized = JSON.stringify(meta);
      const bytes = new TextEncoder().encode(serialized).length;
      if (bytes > DEFAULT_META_MAX_BYTES) {
        console.error(`Error: --meta exceeds ${DEFAULT_META_MAX_BYTES} bytes (got ${bytes})`);
        process.exit(1);
      }
    }

    // 5. Build the actor. Default is a system actor scoped to "cli" so audit
    // trails can distinguish CLI-driven calls from internal flow calls (which
    // use id "flow-engine").
    const actor: Actor = {
      type: "system",
      id: (args.actor as string | undefined) ?? "cli",
      groups: [],
    };
    const tenantId = args.tenant as string | undefined;

    // 6. Bootstrap runtime + dispatch.
    let result: ActionResult;
    let shutdown: (() => Promise<void>) | undefined;
    try {
      const boot = await bootstrapCommandLayer();
      shutdown = boot.shutdown;
      result = await boot.commandLayer.execute({
        command: actionName,
        input,
        channel: "internal",
        actor,
        tenantId,
        meta,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      if (shutdown) await shutdown().catch(() => undefined);
      process.exit(2);
    }

    // 7. Emit result + exit code. Action-layer failures map to exit 2.
    if (outputJson) {
      console.log(JSON.stringify(result));
    } else {
      console.log(JSON.stringify(result, null, 2));
    }

    if (shutdown) await shutdown().catch(() => undefined);

    if (!result.success) {
      process.exit(2);
    }
  },
});
