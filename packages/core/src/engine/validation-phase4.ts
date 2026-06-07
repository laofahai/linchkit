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
// Only `import` (not `export … from`) is accepted: a re-export creates NO local
// binding, so `defineAction(...)` would have nothing to call. Global so callers
// can `matchAll` and verify each match's `import` keyword is real code (not text
// inside a string literal) via index cross-reference against the blanked view.
const IMPORT_CORE_RE = /\bimport\b[^;]*?from\s*["'`]@linchkit\/core["'`]/g;
const REQUIRE_CORE_RE = /\brequire\(\s*["'`]@linchkit\/core["'`]\s*\)/g;

// ── Comment / string stripping ───────────────────────────
// The contract checks must not be satisfiable by a token that appears only in a
// comment (`// defineAction(`) or a string literal (`"call defineAction()"`).
// A regex-only stripper is NOT string-aware — it would corrupt `//` inside a
// string (e.g. a URL "https://x"). So this walks the source ONCE, tracking
// string vs comment state, blanking comments (and optionally string bodies).

/** Blank a span to spaces but keep newlines (for length preservation). */
function blank(span: string): string {
  return span.replace(/[^\n]/g, " ");
}

/**
 * Single left-to-right pass that blanks comments and, when `stripStrings` is
 * true, the BODIES of string / template literals (delimiters kept). It is
 * string/comment aware: a comment marker inside a string is preserved, and a
 * quote inside a comment is ignored. Template-literal interpolation is treated
 * as opaque string content (good enough for these heuristic checks).
 *
 * LENGTH-PRESERVING: every input char maps to exactly one output char (blanked
 * regions become spaces / kept newlines). This lets callers cross-reference an
 * index between the strings-kept and strings-blanked views (used by the import
 * check to confirm an `import` keyword is real code, not text inside a string).
 */
function stripCode(src: string, stripStrings: boolean): string {
  let out = "";
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const start = i;
      i += 2;
      while (i < n && src[i] !== "\n") i++;
      out += blank(src.slice(start, i));
      continue;
    }
    if (c === "/" && next === "*") {
      const start = i;
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i = Math.min(i + 2, n); // consume the closing */ (or stop at EOF)
      out += blank(src.slice(start, i));
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
      const literal = src.slice(start, i);
      // Blank the whole literal (delimiters included) when stripping strings —
      // `code` only needs token positions, not delimiters; this is unambiguously
      // length-preserving so the strings-kept and strings-blanked views align.
      out += stripStrings ? blank(literal) : literal;
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
    const escName = escapeRegExp(change.name);
    if (contract) {
      // The define call must be TIED to the declared name (not just present
      // somewhere alongside the name). Two accepted, REAL-code forms:
      //   1. `const|let|var <name> = defineAction(`  — binding id == declared name.
      //      The identifier survives in `code` (strings/comments blanked), so this
      //      is robust against name-in-string fakes.
      //   2. `defineAction({ … name: "<name>" … })`  — a real call (keyword in
      //      code) whose options object names the declared action. The `name:`
      //      literal lives in a string, so we scan `noComments` (strings kept) but
      //      confirm the `defineAction` keyword sits in real code via index check.
      const callName = escapeRegExp(contract.call);
      const boundByConst = new RegExp(
        `\\b(?:const|let|var)\\s+${escName}\\s*=\\s*${callName}\\s*\\(`,
      ).test(code);
      let boundByName = false;
      if (!boundByConst) {
        // `[^}]*?` keeps the `name:` match INSIDE the call's own options object —
        // it cannot cross the first `}` into unrelated later code (e.g. a separate
        // `const meta = { name: "<declared>" }`). Conservative: a nested object
        // before `name:` ends the scan early → a false warning, never a false pass.
        const callRe = new RegExp(
          `\\b${callName}\\s*\\(\\s*\\{[^}]*?\\bname\\s*:\\s*["'\`]${escName}["'\`]`,
          "g",
        );
        for (const m of noComments.matchAll(callRe)) {
          if (m.index !== undefined && /\S/.test(code[m.index] ?? "")) {
            boundByName = true;
            break;
          }
        }
      }
      if (!boundByConst && !boundByName) {
        findings.push({
          code: "GENERATED_SOURCE_CONTRACT",
          message: `Generated source for ${change.target} "${change.name}" does not define ${contract.call}(...) for "${change.name}".`,
          target: change.name,
        });
      }
    } else if (!new RegExp(`\\b${escName}\\b`).test(noComments)) {
      // No known define-call contract for this target (defensive — materialized
      // changes are `action` today). Fall back to a name-reference check.
      findings.push({
        code: "GENERATED_SOURCE_CONTRACT",
        message: `Generated source for ${change.target} "${change.name}" does not reference its declared name "${change.name}".`,
        target: change.name,
      });
    }

    // The define helper must actually be IMPORTED from @linchkit/core. We scan the
    // strings-KEPT view (so the specifier is visible) but confirm each match's
    // keyword sits in REAL CODE via index cross-reference against the blanked view
    // — a fake import inside a string literal is blanked there (whitespace index).
    const importIsReal = (re: RegExp): boolean => {
      for (const m of noComments.matchAll(re)) {
        if (m.index !== undefined && /\S/.test(code[m.index] ?? "")) return true;
      }
      return false;
    };
    // When the target has a known helper (e.g. `defineAction`), require THAT helper
    // in the import clause — `import { defineEntity } from core` must not satisfy a
    // `defineAction` contract. `require("@linchkit/core")` (destructured) is also
    // accepted. Without a contract, fall back to any real core import.
    const helper = contract?.call;
    const importRe = helper
      ? new RegExp(
          `\\bimport\\b[^;]*?\\b${escapeRegExp(helper)}\\b[^;]*?from\\s*["'\`]@linchkit\\/core["'\`]`,
          "g",
        )
      : IMPORT_CORE_RE;
    const importsCore = importIsReal(importRe) || importIsReal(REQUIRE_CORE_RE);
    if (!importsCore) {
      const what = helper ? `${helper} from "${CORE_IMPORT}"` : `from "${CORE_IMPORT}"`;
      findings.push({
        code: "GENERATED_SOURCE_CONTRACT",
        message: `Generated source for ${change.target} "${change.name}" does not import ${what}.`,
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
