/**
 * Tests for `linch exec` (Spec 65 §3.5).
 *
 * Tests spawn the CLI as a subprocess against a fixture project so the full
 * config-loading + capability-registration + CommandLayer dispatch path is
 * exercised end-to-end. Action handlers communicate with the test process by
 * writing their observed meta + input to a side-channel file under TEST_DIR.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TEST_DIR = resolve(import.meta.dir, ".tmp-test-exec");
const CLI_ENTRY = resolve(import.meta.dir, "../../index.ts");
const SIDE_CHANNEL = resolve(TEST_DIR, "handler-output.json");

/**
 * Write a linchkit.config.ts that registers a single capability with two
 * test actions:
 * - `record_meta`: writes ctx.meta.toJSON() + ctx.input to SIDE_CHANNEL,
 *   returns success.
 * - `boom_action`: throws an Error to exercise the executor's failure path.
 *
 * The handlers use `node:fs` directly (not LinchKit primitives) to keep the
 * fixture self-contained and free of cap-permission so unauthenticated CLI
 * invocations succeed.
 */
function writeFixtureConfig(extras: { sideChannel: string }) {
  const content = `
import { writeFileSync } from "node:fs";

const SIDE_CHANNEL = ${JSON.stringify(extras.sideChannel)};

export default {
  capabilities: [
    {
      name: "cap-exec-test",
      label: "Exec Test",
      type: "standard",
      category: "business",
      version: "0.0.1",
      entities: [
        {
          name: "exec_test",
          label: "ExecTest",
          fields: { name: { type: "text", label: "Name" } },
        },
      ],
      actions: [
        {
          name: "record_meta",
          label: "Record meta",
          entity: "exec_test",
          type: "custom",
          handler: async (ctx) => {
            writeFileSync(
              SIDE_CHANNEL,
              JSON.stringify({ meta: ctx.meta.toJSON(), input: ctx.input }),
            );
            return { recorded: true };
          },
        },
        {
          name: "boom_action",
          label: "Boom",
          entity: "exec_test",
          type: "custom",
          handler: async () => {
            throw new Error("intentional failure");
          },
        },
      ],
    },
  ],
};
`;
  writeFileSync(resolve(TEST_DIR, "linchkit.config.ts"), content);
}

function readSideChannel(): { meta: Record<string, unknown>; input: Record<string, unknown> } {
  return JSON.parse(readFileSync(SIDE_CHANNEL, "utf-8"));
}

function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

describe("linch exec", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
    writeFixtureConfig({ sideChannel: SIDE_CHANNEL });
  });

  afterEach(cleanup);

  test("happy path: dispatches action with input + meta, strips _-keys", async () => {
    const proc = Bun.spawn(
      [
        "bun",
        "run",
        CLI_ENTRY,
        "exec",
        "record_meta",
        "--input",
        JSON.stringify({ id: "pr_001" }),
        "--meta",
        JSON.stringify({
          bulk: true,
          _channel: "spoofed",
          _execution_id: "spoofed",
          _custom_secret: "hax",
        }),
        "--json",
      ],
      { cwd: TEST_DIR, stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
    const stdout = (await new Response(proc.stdout).text()).trim();
    const stderr = await new Response(proc.stderr).text();

    expect(proc.exitCode).toBe(0);
    // Result line is the last JSON output on stdout — bun run may print a banner.
    const lastLine =
      stdout
        .split("\n")
        .filter((l) => l.trim().startsWith("{"))
        .pop() ?? "";
    const result = JSON.parse(lastLine);
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ recorded: true });

    const recorded = readSideChannel();
    expect(recorded.input).toEqual({ id: "pr_001" });
    // Caller-supplied `bulk` key visible to handler.
    expect(recorded.meta.bulk).toBe(true);
    // Framework-set system keys are present with framework values, not the
    // spoofed values the caller tried to inject.
    expect(recorded.meta._channel).toBe("internal");
    expect(recorded.meta._execution_id).not.toBe("spoofed");
    // Caller-prefixed `_`-keys that the framework does NOT manage are dropped
    // entirely (Spec 65 §4.4).
    expect(recorded.meta).not.toHaveProperty("_custom_secret");
    // Surface stderr only if the test fails for context.
    if (proc.exitCode !== 0) console.error(stderr);
  });

  test("invalid --input JSON exits with code 1 and prints to stderr", async () => {
    const proc = Bun.spawn(
      ["bun", "run", CLI_ENTRY, "exec", "record_meta", "--input", "{not-json"],
      { cwd: TEST_DIR, stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(proc.exitCode).toBe(1);
    expect(stderr).toContain("Invalid JSON for --input");
  });

  test("--input + --input-file together exit with code 1", async () => {
    const inputFile = resolve(TEST_DIR, "input.json");
    writeFileSync(inputFile, JSON.stringify({ id: "x" }));

    const proc = Bun.spawn(
      ["bun", "run", CLI_ENTRY, "exec", "record_meta", "--input", "{}", "--input-file", inputFile],
      { cwd: TEST_DIR, stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(proc.exitCode).toBe(1);
    expect(stderr).toContain("mutually exclusive");
  });

  test("action throws → exit 2 with failure result", async () => {
    const proc = Bun.spawn(["bun", "run", CLI_ENTRY, "exec", "boom_action", "--json"], {
      cwd: TEST_DIR,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    const stdout = (await new Response(proc.stdout).text()).trim();

    expect(proc.exitCode).toBe(2);
    // The pipeline returns ActionResult { success: false, ... } before the
    // process exits with code 2 — confirm the failure was reported.
    const lastLine =
      stdout
        .split("\n")
        .filter((l) => l.trim().startsWith("{"))
        .pop() ?? "";
    const result = JSON.parse(lastLine);
    expect(result.success).toBe(false);
  });

  test("--meta exceeding 8 KB exits with code 1", async () => {
    // Generate a string just over 8 KB. JSON-encoded length includes quoting +
    // wrapping object keys, so 9000 bytes of payload is comfortably oversize.
    const big = "x".repeat(9000);
    const proc = Bun.spawn(
      ["bun", "run", CLI_ENTRY, "exec", "record_meta", "--meta", JSON.stringify({ blob: big })],
      { cwd: TEST_DIR, stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(proc.exitCode).toBe(1);
    expect(stderr).toContain("exceeds");
  });
});
