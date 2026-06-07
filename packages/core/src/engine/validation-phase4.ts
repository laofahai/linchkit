/**
 * Validation Phase 4 — Generated-source CONTRACT check (G5).
 *
 * Phase 4 inspects any `generatedSource` attached to a proposal's changes (by the
 * proposal materializer) and checks — WITHOUT EXECUTING ANYTHING — that the AI
 * actually generated the kind of definition the change declares: the right
 * `define<Target>()` call, a reference to the declared name, and an import from
 * `@linchkit/core`. It catches a class of AI errors that pass the Phase 2 syntax
 * gate yet are wrong (e.g. an empty scaffold, the wrong target, or a mismatched
 * name) before a human reviews the candidate.
 *
 * SAFETY — EXECUTION-FREE BY DESIGN ("AI never modifies production directly"):
 * this NEVER `eval`s, `import`s, transpiles-and-runs, or otherwise executes the
 * generated source. It only does static string/structural heuristics. A true
 * execution-based dry-run (running a generated handler against sample/historical
 * data) requires a locked-down sandbox and is intentionally OUT OF SCOPE here —
 * deferred to a separate, sandbox-gated step so untrusted AI code is never run
 * as a side effect of validation.
 *
 * Severity / gating mirrors Phase 2 / Phase 3 (low-regret):
 *   - DEFAULT: WARN-ONLY. Findings are `warnings`; `passed` is unaffected. The
 *     checks are heuristic, so they must not block by default.
 *   - GATED: when `strictGeneratedContract` is true, findings become `errors`
 *     (status "failed" → proposal `passed` = false → blocks).
 *
 * An all-declarative proposal (no `generatedSource`) degrades to "skipped".
 */

import type {
  PhaseResult,
  ProposalChange,
  ProposalChangeTarget,
  ValidationError,
  ValidationWarning,
} from "../types/proposal";

// ── Options ──────────────────────────────────────────────

export interface ValidatePhase4Options {
  /** The proposal's changes to inspect for materialized `generatedSource`. */
  changes: ProposalChange[];
  /**
   * When true, generated-source contract findings become ERRORS (blocking).
   * Default (false / undefined) → findings are WARNINGS only and do not affect
   * `passed`. The checks are heuristic, so warn-only is the safe default.
   */
  strictGeneratedContract?: boolean;
}

const CORE_IMPORT = "@linchkit/core";

/**
 * Per-materializable-target contract: the `define*()` call its generated source
 * must contain, with a pre-compiled detector regex. Only `action` is
 * materializable today (see the proposal materializer's MATERIALIZABLE_TARGETS);
 * other targets are serialized declaratively and never carry `generatedSource`.
 * A target absent from this map skips the call check (name/import checks still
 * run). `\b...\(` matches a real call after comment/string removal.
 */
const CONTRACT_BY_TARGET: Partial<Record<ProposalChangeTarget, { call: string; re: RegExp }>> = {
  action: { call: "defineAction", re: /\bdefineAction\s*\(/ },
};

// Pre-compiled core-import detectors (recreating per change/iteration is wasteful).
// `@linchkit/core` contains no regex metacharacters, so these literals are exact.
// `[^;]*?` allows a multi-line import clause bounded by the statement terminator.
const IMPORT_CORE_RE = /(?:import|export)\b[^;]*?from\s*["'`]@linchkit\/core["'`]/;
const REQUIRE_CORE_RE = /require\(\s*["'`]@linchkit\/core["'`]\s*\)/;

// ── Comment / string stripping ───────────────────────────
// The contract checks must not be satisfiable by a token that appears only in a
// comment (`// defineAction(`) or a string literal (`"call defineAction()"`).
// A regex-only stripper is NOT string-aware — it would corrupt `//` inside a
// string (e.g. a URL "https://x"). So this walks the source ONCE, tracking
// string vs comment state, blanking comments (and optionally string bodies).

/**
 * Single left-to-right pass that removes comments and, when `stripStrings` is
 * true, the BODIES of string / template literals (delimiters kept). It is
 * string/comment aware: a comment marker inside a string is preserved, and a
 * quote inside a comment is ignored. Template-literal interpolation is treated
 * as opaque string content (good enough for these heuristic checks).
 */
function stripCode(src: string, stripStrings: boolean): string {
  let out = "";
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      i += 2;
      while (i < n && src[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2; // skip the closing */
      out += " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      const start = i;
      i++;
      while (i < n) {
        if (src[i] === "\\") {
          i += 2;
          continue;
        }
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      out += stripStrings ? `${quote}${quote}` : src.slice(start, i);
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Remove comments only (string bodies preserved). */
function stripComments(src: string): string {
  return stripCode(src, false);
}

/** Remove comments AND string / template literal bodies. */
function stripCommentsAndStrings(src: string): string {
  return stripCode(src, true);
}

/** Escape a string for safe interpolation into a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Entry point ──────────────────────────────────────────

/**
 * Run Phase 4 (generated-source contract) validation on a proposal's changes.
 *
 * Returns a PhaseResult:
 *  - no change carries a non-empty `generatedSource` → status "skipped"
 *  - findings + strictGeneratedContract=false → status "passed" with `warnings`
 *  - findings + strictGeneratedContract=true  → status "failed" with `errors`
 */
export function validatePhase4(options: ValidatePhase4Options): PhaseResult {
  const { changes, strictGeneratedContract = false } = options;
  const start = Date.now();

  // Only NON-EMPTY generated sources have a contract to check. An empty /
  // whitespace materialization is a Phase 2 (syntax) finding — not re-flagged
  // here. Declarative changes (no generatedSource) have nothing to check.
  const withSource = changes.filter(
    (c) => typeof c.generatedSource === "string" && c.generatedSource.trim().length > 0,
  );

  if (withSource.length === 0) {
    return { phase: 4, status: "skipped", errors: [], warnings: [], duration: Date.now() - start };
  }

  const findings: Array<{ code: string; message: string; target?: string }> = [];
  for (const change of withSource) {
    const source = change.generatedSource as string;
    // Code with comments+strings removed → a `define*()` call here is a REAL call,
    // not a mention in a comment/string. Comments-only removed → keeps the
    // import specifier string and the name (which legitimately appears as the
    // definition's `name:` literal).
    const code = stripCommentsAndStrings(source);
    const noComments = stripComments(source);

    const contract = CONTRACT_BY_TARGET[change.target];
    if (contract && !contract.re.test(code)) {
      findings.push({
        code: "GENERATED_SOURCE_CONTRACT",
        message: `Generated source for ${change.target} "${change.name}" does not call ${contract.call}(...).`,
        target: change.name,
      });
    }

    // The generated definition should reference its declared name. A missing name
    // usually means the AI generated something unrelated or a bare stub. The name
    // may appear as an identifier or as the definition's `name:` literal, so this
    // check runs on the comments-stripped (string-preserving) source. Match on a
    // word boundary so a different name that merely CONTAINS the declared one
    // (e.g. `do_thing_v2` for `do_thing`) does not satisfy it — `_` is a word
    // char, so `\bdo_thing\b` won't match inside `do_thing_v2`.
    const nameRef = new RegExp(`\\b${escapeRegExp(change.name)}\\b`);
    if (!nameRef.test(noComments)) {
      findings.push({
        code: "GENERATED_SOURCE_CONTRACT",
        message: `Generated source for ${change.target} "${change.name}" does not reference its declared name "${change.name}".`,
        target: change.name,
      });
    }

    // Definitions need the define* helpers, which come from @linchkit/core. Match
    // a real import/export-from or require() statement (not a bare mention) so a
    // comment or unrelated string can't satisfy it. `[^;]*?` allows multi-line
    // import clauses bounded by the statement terminator.
    const importsCore = IMPORT_CORE_RE.test(noComments) || REQUIRE_CORE_RE.test(noComments);
    if (!importsCore) {
      findings.push({
        code: "GENERATED_SOURCE_CONTRACT",
        message: `Generated source for ${change.target} "${change.name}" does not import from "${CORE_IMPORT}".`,
        target: change.name,
      });
    }
  }

  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  if (strictGeneratedContract) {
    for (const f of findings) errors.push(f);
  } else {
    for (const f of findings) warnings.push(f);
  }

  // Warn-only by default: status stays "passed" even with warnings — `passed` is
  // only dragged false when strictGeneratedContract escalated findings to errors.
  const status: PhaseResult["status"] = errors.length === 0 ? "passed" : "failed";

  return { phase: 4, status, errors, warnings, duration: Date.now() - start };
}
