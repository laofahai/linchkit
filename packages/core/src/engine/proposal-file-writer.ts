/**
 * ProposalFileWriter — Spec 55 §7.6 "Graduation: from data to code".
 *
 * Persists the changes carried by an approved Proposal as TypeScript source
 * files under the target capability's tree. Once written, the developer can
 * review the diff in source control, run their build, and ship — closing the
 * human-in-the-loop hand-off between Memory-resident proposals and Layer 0
 * (Git) source-of-truth.
 *
 * This is intentionally a thin writer:
 *   - Git commits are delegated to the caller (e.g. ProposalGitCommitter).
 *   - No template inheritance — each change kind gets a small, predictable stub.
 *
 * Source can optionally be piped through a formatter (Biome by default via
 * a `bunx @biomejs/biome` CLI spawn) so the on-disk output matches the repo
 * style and does not produce churn on the developer's first save.
 *
 * The default behaviour assumes the standard `addons/<group>/cap-<short>/src/...`
 * layout. Consumers can override path resolution and codegen via the options
 * if their capability lives elsewhere or carries an unusual ChangeDefinition.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { dirname, join } from "node:path";
import type { Logger } from "../types/logger";
import type { ProposalChange, ProposalChangeTarget, ProposalDefinition } from "../types/proposal";
import type { SourcePatcher } from "../types/source-patch";

// ── Formatter ───────────────────────────────────────────────

/** Async function that returns formatted TypeScript source. */
export type ProposalSourceFormatter = (source: string, filename: string) => Promise<string>;

/**
 * Formatter option:
 *   - `false` / `undefined` — no formatting (raw codegen output, default).
 *   - `true` — pipe source through `bunx @biomejs/biome format --stdin-file-path`.
 *   - Custom async function — full control over the formatting pass.
 */
export type ProposalFormatterOption = boolean | ProposalSourceFormatter;

// ── Options ─────────────────────────────────────────────────

export interface ProposalFileWriterOptions {
  /** Absolute path to the repository root — used to resolve `addons/<group>/cap-<short>/src/...`. */
  rootDir: string;
  /** Optional logger (defaults to a console-prefixed shim). */
  logger?: Logger;
  /** Override the resolved path per change. Returns an absolute path. */
  pathResolver?: (proposal: ProposalDefinition, change: ProposalChange) => string;
  /** Custom code generator (escape hatch for unusual ChangeDefinition shapes). */
  codegen?: (proposal: ProposalDefinition, change: ProposalChange) => string;
  /**
   * Opt-in source formatter. Defaults to no formatting so the writer's
   * behaviour stays backwards-compatible. When provided, the formatter runs
   * after codegen and before the file is written. Failures are swallowed and
   * the un-formatted source is written instead (formatting is cosmetic — it
   * must never block code generation).
   */
  formatter?: ProposalFormatterOption;
  /**
   * Injected source patcher for in-place named-constant edits (#566).
   *
   * Required to graduate a change carrying `change.sourcePatch`. The concrete
   * TypeScript-AST patcher lives OUTSIDE `@linchkit/core` (it imports
   * `typescript`); core only calls this seam. When absent, a `sourcePatch`
   * change FAILS LOUD (it cannot be graduated by deterministic codegen).
   */
  sourcePatcher?: SourcePatcher;
  /**
   * Base directory for resolving `change.sourcePatch.filePath` (#566). The
   * resolved absolute path is rejected if it escapes this root. Defaults to
   * `process.cwd()`.
   */
  repoRoot?: string;
}

// ── Defaults ────────────────────────────────────────────────

/**
 * Change targets that materialise a source file on disk. `"revert"` is excluded
 * because a rollback change (Spec 55 §7.7) has no definition file to write — it
 * is skipped by `writeApprovedProposal` before any map lookup happens. Keeping
 * the maps keyed by this `Exclude<…>` type preserves exhaustiveness over the
 * writable targets without inventing a fake `"revert"` entry.
 */
type WritableChangeTarget = Exclude<ProposalChangeTarget, "revert">;

/** Map a change target to its subdirectory (relative to `<cap>/src/`). */
const TARGET_SUBDIR: Record<WritableChangeTarget, string> = {
  entity: "entities",
  relation: "relations",
  action: "actions",
  rule: "rules",
  view: "views",
  state: "states",
  event: "events",
  flow: "flows",
  overlay: "overlays",
};

/** Map a change target to its file-name discriminator. */
const TARGET_KIND_SUFFIX: Record<WritableChangeTarget, string> = {
  entity: "entity",
  relation: "relation",
  action: "action",
  rule: "rule",
  view: "view",
  state: "state",
  event: "event",
  flow: "flow",
  overlay: "overlay",
};

/** Map a change target to its `defineXxx` factory name. */
const TARGET_FACTORY: Record<WritableChangeTarget, string> = {
  entity: "defineEntity",
  relation: "defineRelation",
  action: "defineAction",
  rule: "defineRule",
  view: "defineView",
  state: "defineState",
  event: "defineEvent",
  flow: "defineFlow",
  overlay: "defineOverlay",
};

/** Slug cap — keeps filenames readable on every filesystem. */
const MAX_SLUG_LENGTH = 40;
/** Suffix length for the short-id tail — matches ProposalGitCommitter. */
const SHORT_ID_LENGTH = 8;

/**
 * Normalise the proposal's `capability` field into the cap-prefixed directory
 * name we expect under `addons/<group>/`. The proposal stores it either as
 * `"cap-life-demo"` (already prefixed) or `"life_demo"` / `"life-demo"`
 * (bare). We always emit the `cap-…` form.
 */
function normaliseCapName(capability: string): string {
  if (capability.startsWith("cap-")) return capability;
  // snake_case → kebab-case so the on-disk folder name is consistent.
  return `cap-${capability.replace(/_/g, "-")}`;
}

/**
 * Best-effort lookup of the `<group>` segment in `addons/<group>/cap-<short>/`.
 *
 * The proposal does not carry the group name (Capabilities are addressed by
 * their `cap-*` name only). We scan `addons/` once and find the first child
 * directory that contains `cap-<short>`. If none is found we fall back to
 * `<short minus 'cap-'>` which matches the convention used by single-member
 * groups (e.g. `addons/permission/cap-permission/`).
 */
async function resolveCapGroup(rootDir: string, capName: string): Promise<string> {
  const addonsRoot = join(rootDir, "addons");
  if (!existsSync(addonsRoot)) {
    return capName.replace(/^cap-/, "");
  }
  try {
    const groups = await readdir(addonsRoot, { withFileTypes: true });
    for (const entry of groups) {
      if (!entry.isDirectory()) continue;
      const candidate = join(addonsRoot, entry.name, capName);
      if (existsSync(candidate)) return entry.name;
    }
  } catch {
    // fall through to default
  }
  return capName.replace(/^cap-/, "");
}

/** Slugify a free-form title into a filename-safe segment (lowercase a-z0-9 + `-`). */
function slugifyTitle(title: string | undefined, maxLength = MAX_SLUG_LENGTH): string {
  if (!title) return "";
  const normalised = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (normalised.length === 0) return "";
  if (normalised.length <= maxLength) return normalised;
  // Trim any trailing dash created by the cap so we never emit `…-`.
  return normalised.slice(0, maxLength).replace(/-+$/, "");
}

/** Tail of the proposal id, matching ProposalGitCommitter's short-id convention. */
function shortIdOf(proposalId: string): string {
  return proposalId.length <= SHORT_ID_LENGTH
    ? proposalId
    : proposalId.slice(proposalId.length - SHORT_ID_LENGTH);
}

/**
 * Convert a `Date | string | undefined` into a YYYYMMDD UTC date stamp.
 * Falls back to today (UTC) when the input is missing or unparseable.
 */
function dateStampOf(value: Date | string | undefined): string {
  let date: Date | undefined;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) date = parsed;
  }
  if (!date || Number.isNaN(date.getTime())) {
    date = new Date();
  }
  const yyyy = date.getUTCFullYear().toString().padStart(4, "0");
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const dd = date.getUTCDate().toString().padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

/** Build the prefix segment `YYYYMMDD[__slug]__shortId` (no extension). */
function buildFilenamePrefix(proposal: ProposalDefinition): string {
  const date = dateStampOf(proposal.createdAt);
  const slug = slugifyTitle(proposal.title);
  const sid = shortIdOf(proposal.id);
  // Always single `__` between adjacent segments — when the slug is empty we
  // collapse `date__slug__sid` (with an empty middle) into `date__sid`.
  const middle = slug.length === 0 ? "" : `${slug}__`;
  return `_${date}__${middle}${sid}`;
}

/** Build a default header comment for a generated file. */
function buildHeader(proposal: ProposalDefinition, change: ProposalChange): string {
  const now = new Date().toISOString();
  return [
    "/**",
    " * AUTO-GENERATED by ProposalFileWriter (Spec 55 §7.6).",
    " *",
    ` * Sourced from Proposal: ${proposal.id}`,
    ` * Title:                 ${proposal.title}`,
    ` * Capability:            ${proposal.capability}`,
    ` * Change target:         ${change.target} (${change.operation})`,
    ` * Generated at:          ${now}`,
    " *",
    " * Review the diff in source control. Edit freely — this file is intended",
    " * to be the persistent, human-curated form of the proposed change.",
    " */",
    "",
  ].join("\n");
}

/** Narrow a change target to a writable one, throwing if it is `"revert"`. */
function assertWritableTarget(target: ProposalChangeTarget): WritableChangeTarget {
  if (target === "revert") {
    // Unreachable in normal flow — writeApprovedProposal skips revert changes
    // before any path/codegen resolution. Guards against future callers.
    throw new Error(
      'ProposalFileWriter: "revert" changes carry no source file and cannot be written',
    );
  }
  return target;
}

/** Fields a `rule` definition must carry to be deterministically serialisable. */
const RULE_REQUIRED_FIELDS = ["trigger", "condition", "effect"] as const;

/**
 * Refuse to deterministically serialise a change whose effective definition
 * cannot round-trip to valid source — FAIL LOUD instead of writing a corrupt
 * stub (#566). Only invoked WITHOUT a trusted `generatedSource`; a materialized
 * change is written verbatim and never reaches this guard. Two un-serialisable
 * cases are detected (today scoped to `rule`, the only target scaffolded from a
 * structured definition):
 *
 *   (a) The effective definition (`change.definition ?? {}`) lacks a required
 *       field (trigger / condition / effect). This is the code-condition
 *       `requiresCodeChange:true` case where the NL resolver intentionally left
 *       `definition` undefined; the old `?? { name: change.name }` fallback would
 *       have emitted `defineRule({ "name": "…" })` — a stub missing the rule's
 *       behaviour. We refuse instead.
 *   (b) A required field carries a FUNCTION (e.g. a `CodeCondition`).
 *       `JSON.stringify` silently DROPS it, emitting a broken rule with the field
 *       lost. We refuse rather than corrupt.
 *
 * The fix a caller is pointed at: such a code-condition change (create or
 * update) needs a materialized `generatedSource` (the AI materializer), not
 * deterministic codegen.
 */
function assertGraduatable(proposal: ProposalDefinition, change: ProposalChange): void {
  const target = assertWritableTarget(change.target);
  // Only `rule` is scaffolded from a structured definition with mandatory
  // behavioural fields today; other targets ship a self-contained declarative
  // definition or arrive with `generatedSource`. Keep the guard scoped so we
  // never regress them.
  if (target !== "rule") return;

  const definition = (change.definition ?? {}) as Record<string, unknown>;
  // Common prefix names the proposal id, change name and target (the required
  // "what"); each branch appends the specific "why" + the materialization fix.
  const where = `${target} "${change.name}" (proposal "${proposal.id}")`;
  // Operation-aware so the message reads correctly for BOTH a code-condition
  // update and a brand-new create that carries a function condition.
  const fix =
    `such a code-condition ${change.operation} needs a materialized \`generatedSource\` ` +
    "(the AI materializer), not deterministic codegen — refusing to write an invalid stub.";

  for (const field of RULE_REQUIRED_FIELDS) {
    const value = definition[field];
    if (value === undefined || value === null) {
      throw new Error(
        `ProposalFileWriter: cannot deterministically serialize ${where} — its definition has ` +
          `no "${field}" (the code-condition case where the NL resolver intentionally left the ` +
          `definition undefined); ${fix}`,
      );
    }
    if (typeof value === "function") {
      throw new Error(
        `ProposalFileWriter: cannot deterministically serialize ${where} — its "${field}" is a ` +
          `function (code condition); JSON.stringify would silently drop it, emitting a rule ` +
          `with "${field}" lost; ${fix}`,
      );
    }
  }
}

/** Default codegen: import the matching `defineXxx` and re-emit the change. */
function defaultCodegen(proposal: ProposalDefinition, change: ProposalChange): string {
  const factory = TARGET_FACTORY[assertWritableTarget(change.target)];
  // `assertGraduatable` runs BEFORE codegen and refuses the un-serialisable
  // cases, so a `rule` always carries trigger/condition/effect here. The
  // `?? { name }` default only covers non-rule targets that serialise from a
  // name-only definition.
  const definition = change.definition ?? { name: change.name };
  const header = buildHeader(proposal, change);

  // Use JSON.stringify with `null, 2` for the "frozen-at-write-time" shape.
  // Functions / Dates inside ChangeDefinition will be lost — that's by design;
  // the developer is expected to massage anything dynamic in-source.
  const serialized = JSON.stringify(definition, null, 2);

  return `${header}import { ${factory} } from "@linchkit/core";\n\nexport default ${factory}(${serialized});\n`;
}

/**
 * Default formatter — spawns `bunx @biomejs/biome format --stdin-file-path=<filename>`
 * and pipes the source through its stdin. Returns the stdout when Biome exits
 * cleanly, or throws on non-zero exit. The caller (writeApprovedProposal)
 * catches and logs the failure so codegen is never blocked by a cosmetic step.
 */
async function defaultBiomeFormatter(source: string, filename: string): Promise<string> {
  // We rely on the CLI rather than `@biomejs/js-api` because the latter is
  // not a direct dep of @linchkit/core. The repo already ships Biome via the
  // root `bunx @biomejs/biome` invocation used by `bun run check`.
  const proc = Bun.spawn(["bunx", "@biomejs/biome", "format", `--stdin-file-path=${filename}`], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Write the source and close stdin so Biome can finish reading.
  proc.stdin.write(source);
  await proc.stdin.end();
  // Drain stdout and stderr concurrently to avoid deadlocking on full buffers.
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(
      `Biome formatter exited with code ${exitCode}: ${stderr.trim() || "<no stderr>"}`,
    );
  }
  return stdout;
}

/** Resolve the configured formatter option into a callable function (or `undefined`). */
function resolveFormatter(
  option: ProposalFormatterOption | undefined,
): ProposalSourceFormatter | undefined {
  if (!option) return undefined;
  if (option === true) return defaultBiomeFormatter;
  return option;
}

// ── ProposalFileWriter ──────────────────────────────────────

export class ProposalFileWriter {
  private readonly rootDir: string;
  private readonly logger?: Logger;
  private readonly pathResolver?: (proposal: ProposalDefinition, change: ProposalChange) => string;
  private readonly codegen: (proposal: ProposalDefinition, change: ProposalChange) => string;
  private readonly formatter?: ProposalSourceFormatter;
  /**
   * Whether the deterministic {@link defaultCodegen} is in use (no custom
   * `codegen` was supplied). The {@link assertGraduatable} guard encodes the
   * constraints of `defaultCodegen` specifically (JSON.stringify drops
   * functions; a rule needs trigger/condition/effect). A caller-supplied
   * `codegen` is an escape hatch for unusual `ChangeDefinition` shapes and may
   * handle exactly those cases — so the guard must NOT pre-empt it.
   */
  private readonly usesDefaultCodegen: boolean;
  /** Injected in-place source patcher for `sourcePatch` changes (#566). */
  private readonly sourcePatcher?: SourcePatcher;
  /** Base dir for resolving `sourcePatch.filePath`; defaults to `process.cwd()`. */
  private readonly repoRoot: string;

  constructor(options: ProposalFileWriterOptions) {
    this.rootDir = options.rootDir;
    this.logger = options.logger;
    this.pathResolver = options.pathResolver;
    this.usesDefaultCodegen = options.codegen === undefined;
    this.codegen = options.codegen ?? defaultCodegen;
    this.formatter = resolveFormatter(options.formatter);
    this.sourcePatcher = options.sourcePatcher;
    this.repoRoot = options.repoRoot ?? process.cwd();
  }

  /**
   * Write every change in an approved proposal to disk.
   *
   * Throws if `proposal.status !== "approved"` (defensive — the writer is
   * only meant to be invoked from the approval hook, never directly).
   *
   * For each change:
   *   - Resolves the target path (`pathResolver` or default layout).
   *   - Generates TypeScript source (`codegen` or default factory wrap).
   *   - Optionally pipes the source through `formatter` (errors swallowed).
   *   - Creates any missing parent directories.
   *   - Refuses to overwrite an existing file when `change.operation === "create"`.
   *   - Allows overwrite when `change.operation === "update"`.
   *   - Delete operations are intentionally skipped — deleting a Capability's
   *     source file is too destructive to do silently from an approval hook.
   *
   * Returns the list of absolute paths actually written.
   */
  async writeApprovedProposal(proposal: ProposalDefinition): Promise<string[]> {
    if (proposal.status !== "approved") {
      throw new Error(
        `ProposalFileWriter requires status "approved" — got "${proposal.status}" for proposal "${proposal.id}"`,
      );
    }

    // Resolve the capability group once per proposal — all changes share
    // the same capability, so the readdir scan in resolveCapGroup would
    // otherwise repeat for every change.
    const groupCache = new Map<string, string>();

    const written: string[] = [];
    for (const change of proposal.changes) {
      // A revert change (Spec 55 §7.7 rollback loop) has no definition file to
      // write — it instructs a separate human-approved deploy step to roll back
      // the named proposal. Skip it here, mirroring the delete-operation skip.
      if (change.target === "revert") {
        this.logger?.warn?.(
          `ProposalFileWriter: skipping revert change "${change.name}" — no source file to write; rollback is handled by the deploy pipeline`,
          { proposalId: proposal.id, target: change.target, name: change.name },
        );
        continue;
      }

      if (change.operation === "delete") {
        this.logger?.warn?.(
          `ProposalFileWriter: skipping delete operation for "${change.name}" — manual removal required`,
          { proposalId: proposal.id, target: change.target, name: change.name },
        );
        continue;
      }

      // In-place named-constant patch (#566) — a THIRD graduation path that
      // takes precedence for a `sourcePatch` change. It does NOT use
      // `pathResolver` / `rootDir` / codegen: the file already exists and is
      // edited in place via the injected `SourcePatcher`. Changes WITHOUT a
      // `sourcePatch` fall through to the unchanged materialized-source / codegen
      // path below.
      if (change.sourcePatch) {
        const patched = await this.applySourcePatch(proposal, change);
        written.push(patched);
        continue;
      }

      const targetPath = await this.resolvePath(proposal, change, groupCache);
      // Prefer AI-materialized source (G5) when it has real content: the
      // materializer attaches `generatedSource` for code targets (e.g. an action
      // handler body) that the deterministic codegen can only scaffold. Without
      // this, a materialized proposal would graduate to a PR containing a stub,
      // silently dropping the generated logic. An empty / whitespace
      // generatedSource is treated as absent so a malformed materialization can
      // never write a blank file — it falls back to the deterministic scaffold
      // (Phase 2 also flags the empty source upstream). Declarative changes have
      // no generatedSource → codegen.
      const hasGeneratedSource =
        typeof change.generatedSource === "string" && change.generatedSource.trim().length > 0;
      let rawSource: string;
      if (hasGeneratedSource) {
        rawSource = change.generatedSource as string;
      } else {
        // No trusted materialized source — deterministically serialize
        // `change.definition`, but refuse FIRST if it can't round-trip to valid
        // source so a code-condition / requiresCodeChange:true draft FAILS LOUD
        // here instead of graduating a corrupt stub (#566). The guard only
        // applies to `defaultCodegen`; a caller-supplied `codegen` is an escape
        // hatch that may legitimately handle code-condition / function-bearing
        // definitions itself, so we must not pre-empt it.
        if (this.usesDefaultCodegen) {
          assertGraduatable(proposal, change);
        }
        rawSource = this.codegen(proposal, change);
      }
      const source = await this.maybeFormat(rawSource, targetPath, proposal);
      await mkdir(dirname(targetPath), { recursive: true });

      // Use the `wx` flag for creates so the OS atomically refuses an
      // existing file — avoids the TOCTOU race between an `existsSync`
      // check and the subsequent write.
      const flag = change.operation === "create" ? "wx" : "w";
      try {
        await writeFile(targetPath, source, { encoding: "utf8", flag });
      } catch (err) {
        if (change.operation === "create" && (err as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(
            `ProposalFileWriter: refusing to overwrite existing file at "${targetPath}" ` +
              `(proposal "${proposal.id}" change "${change.name}" is a create operation). ` +
              `If this is an intentional rewrite, change operation to "update".`,
          );
        }
        throw err;
      }

      this.logger?.info?.(`ProposalFileWriter: wrote ${targetPath}`, {
        proposalId: proposal.id,
        target: change.target,
        name: change.name,
        operation: change.operation,
      });
      written.push(targetPath);
    }

    return written;
  }

  /**
   * Graduate a `sourcePatch` change by patching a named constant in an EXISTING
   * file IN PLACE (#566). Returns the absolute path of the patched file.
   *
   * Steps (in order):
   *   1. Require an injected `sourcePatcher` — a `sourcePatch` change cannot be
   *      graduated by deterministic codegen, so FAIL LOUD if it is missing.
   *   2. Resolve the absolute path under `repoRoot` and reject any path that
   *      escapes it (path-traversal safety).
   *   3. Read the existing file — FAIL LOUD if it is missing.
   *   4. Call the injected patcher and write its output back in place.
   */
  private async applySourcePatch(
    proposal: ProposalDefinition,
    change: ProposalChange,
  ): Promise<string> {
    // `change.sourcePatch` is guaranteed present by the caller, but narrow it
    // locally so this helper is self-contained.
    const patch = change.sourcePatch;
    if (!patch) {
      throw new Error(
        `ProposalFileWriter: applySourcePatch called without a sourcePatch ` +
          `(proposal "${proposal.id}" change "${change.name}")`,
      );
    }

    if (!this.sourcePatcher) {
      throw new Error(
        `ProposalFileWriter: change "${change.name}" (proposal "${proposal.id}") carries a ` +
          `sourcePatch but no \`sourcePatcher\` was injected — an in-place named-constant edit ` +
          `cannot be graduated by deterministic codegen. Inject a SourcePatcher to enable it.`,
      );
    }

    // Path safety: resolve under repoRoot and reject anything that escapes it.
    const abs = path.resolve(this.repoRoot, patch.filePath);
    const rel = path.relative(this.repoRoot, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(
        `ProposalFileWriter: sourcePatch.filePath "${patch.filePath}" escapes repoRoot ` +
          `"${this.repoRoot}" (proposal "${proposal.id}" change "${change.name}") — refusing to ` +
          `patch a file outside the repository.`,
      );
    }

    if (!existsSync(abs)) {
      throw new Error(
        `ProposalFileWriter: sourcePatch target file "${abs}" does not exist ` +
          `(proposal "${proposal.id}" change "${change.name}") — the file to patch is missing.`,
      );
    }

    const source = await readFile(abs, "utf8");
    const result = this.sourcePatcher({
      source,
      constantName: patch.constantName,
      newValueLiteral: patch.newValueLiteral,
    });
    // Skip the write when the value is already at target (changed === false):
    // rewriting identical bytes is wasteful I/O and bumps the file's mtime,
    // needlessly tripping file watchers / HMR / build tools (gemini #590).
    if (result.changed) {
      await writeFile(abs, result.source, { encoding: "utf8", flag: "w" });
    }

    this.logger?.info?.(`ProposalFileWriter: patched ${abs}`, {
      proposalId: proposal.id,
      target: change.target,
      name: change.name,
      constantName: patch.constantName,
      changed: result.changed,
    });

    return abs;
  }

  /**
   * Run the configured formatter, swallowing failures so the write itself
   * always succeeds. Returns the original `source` when no formatter is
   * configured or the formatter throws.
   */
  private async maybeFormat(
    source: string,
    targetPath: string,
    proposal: ProposalDefinition,
  ): Promise<string> {
    if (!this.formatter) return source;
    try {
      return await this.formatter(source, targetPath);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger?.warn?.(
        `ProposalFileWriter: formatter failed for "${targetPath}", writing un-formatted source`,
        { proposalId: proposal.id, error: reason },
      );
      return source;
    }
  }

  /** Resolve the absolute write path for a change. */
  private async resolvePath(
    proposal: ProposalDefinition,
    change: ProposalChange,
    groupCache?: Map<string, string>,
  ): Promise<string> {
    if (this.pathResolver) return this.pathResolver(proposal, change);

    const capName = normaliseCapName(proposal.capability);
    let group = groupCache?.get(capName);
    if (group === undefined) {
      group = await resolveCapGroup(this.rootDir, capName);
      groupCache?.set(capName, group);
    }
    const writableTarget = assertWritableTarget(change.target);
    const subdir = TARGET_SUBDIR[writableTarget];
    const kindSuffix = TARGET_KIND_SUFFIX[writableTarget];
    // Include the change name so multiple changes of the same target kind
    // within one proposal don't collide on the same path.
    const safeName = change.name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const prefix = buildFilenamePrefix(proposal);
    const filename = `${prefix}.${safeName}.${kindSuffix}.ts`;
    return join(this.rootDir, "addons", group, capName, "src", subdir, filename);
  }
}
