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
 * Phase 4 ALSO reports materializable changes whose code generation FAILED the
 * build/syntax gate (`materializationStatus: "failed"`, no `generatedSource` — the
 * materializer cleared it). Such a change has no working candidate code, so it
 * must not pass silently: a finding is emitted (distinct `GENERATED_SOURCE_FAILED`
 * code) so a reviewer cannot approve + graduate a proposal carrying a change with
 * no valid code. These findings inherit the SAME warn/error gating as the
 * contract checks below.
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
import { isMaterializable } from "./proposal-materializer";

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
 * Per-materializable-target contract: the `define*()` helper its generated source
 * must call (and import). Only `action` is materializable today (see the proposal
 * materializer's MATERIALIZABLE_TARGETS); other targets are serialized
 * declaratively and never carry `generatedSource`. A target absent from this map
 * falls back to a bare name-reference check.
 */
const CONTRACT_BY_TARGET: Partial<Record<ProposalChangeTarget, string>> = {
  action: "defineAction",
};

// Pre-compiled core-import detectors (recreating per change/iteration is wasteful).
// `@linchkit/core` contains no regex metacharacters, so these literals are exact.
// `[^;]*?` allows a multi-line import clause bounded by the statement terminator.
// Fallback (no known helper): any real `import … from "@linchkit/core"`. Only
// `import` (not `export … from`) — a re-export creates NO local binding. Global so
// callers can `matchAll` and verify each match's `import` keyword is real code
// (not text inside a string literal) via index cross-reference vs the blanked view.
const IMPORT_CORE_RE = /\bimport\b[^;]*?from\s*["'`]@linchkit\/core["'`]/g;

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
 *  - nothing to report (no non-empty `generatedSource` AND no failed
 *    materialization) → status "skipped"
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

  // Materializable changes whose code generation FAILED the build gate. They
  // carry no `generatedSource` (cleared on failure) so the contract loop never
  // sees them — but they must be reported, not skipped: a failed change has no
  // working candidate code and must block graduation under strict gating.
  //
  // Guard with `isMaterializable` (the SAME predicate the materializer uses) so a
  // change carrying a STALE "failed" status from when it WAS materializable but
  // since edited to a non-materializable target/operation (e.g. action→entity,
  // create→delete) is NOT flagged as a failed code generation — it no longer
  // needs code at all, so reporting it (and blocking under strict) would be wrong.
  const failed = changes.filter((c) => c.materializationStatus === "failed" && isMaterializable(c));

  // Skip ONLY when there is genuinely nothing to report — neither a contract to
  // check nor a failed materialization to flag.
  if (withSource.length === 0 && failed.length === 0) {
    return { phase: 4, status: "skipped", errors: [], warnings: [], duration: Date.now() - start };
  }

  const findings: Array<{ code: string; message: string; target?: string }> = [];

  // Failed-materialization findings. A failed change has no `generatedSource`, so
  // it is never in `withSource` — the two loops do not double-count.
  for (const change of failed) {
    let detail = "";
    // Defensively keep only non-empty STRING entries before joining. The field is
    // typed `string[]`, but it can be rehydrated from persisted JSON, so guard
    // against a malformed array (empty strings → "a; ; b" / trailing "; ", or a
    // non-string slipping past the type) producing a malformed finding message.
    const cleanErrors = Array.isArray(change.materializationErrors)
      ? change.materializationErrors.filter(
          (e): e is string => typeof e === "string" && e.trim().length > 0,
        )
      : [];
    if (cleanErrors.length > 0) {
      const joined = cleanErrors.join("; ");
      // Cap the joined errors so a single finding message stays reasonable.
      const capped = joined.length > 300 ? `${joined.slice(0, 297)}...` : joined;
      detail = ` Build-gate errors: ${capped}`;
    }
    findings.push({
      code: "GENERATED_SOURCE_FAILED",
      message: `Materializable ${change.target} "${change.name}" failed code generation — no candidate source passed the build gate; it cannot be safely graduated.${detail}`,
      target: change.name,
    });
  }

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
      // The contract is satisfied only by a REAL `defineAction({ … name: "<name>" … })`
      // call whose OPTIONS-OBJECT name is the declared action. The registered
      // `ActionDefinition.name` comes from that `name:` literal — NOT from the
      // variable it's assigned to (`const do_thing = defineAction({ name: "other" })`
      // registers `other`), so the const-binding name is intentionally NOT trusted.
      // The `name:` literal lives in a string, so we scan `noComments` (strings
      // kept) but confirm the `defineAction` keyword sits in real code via the
      // index cross-reference. `[^}]*?` keeps the match INSIDE the call's own
      // options object — it cannot cross the first `}` into unrelated later code
      // (e.g. a separate `const meta = { name: "<declared>" }`). Conservative: a
      // nested object before `name:` ends the scan early → a false warning, never
      // a false pass.
      const callName = escapeRegExp(contract);
      const callRe = new RegExp(
        `\\b${callName}\\s*\\(\\s*\\{[^}]*?\\bname\\s*:\\s*["'\`]${escName}["'\`]`,
        "g",
      );
      let definesDeclared = false;
      for (const m of noComments.matchAll(callRe)) {
        if (m.index !== undefined && /\S/.test(code[m.index] ?? "")) {
          definesDeclared = true;
          break;
        }
      }
      if (!definesDeclared) {
        findings.push({
          code: "GENERATED_SOURCE_CONTRACT",
          message: `Generated source for ${change.target} "${change.name}" does not define ${contract}(...) for "${change.name}".`,
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
    // `defineAction` contract. Without a contract, fall back to any real core
    // import. Generated definition source is ESM (the materializer prompts for
    // `import … from "@linchkit/core"`), so CommonJS `require` is intentionally
    // not accepted — a require-based file simply gets an (advisory) import warning.
    // `(?!\s+type\b)` rejects a type-only `import type { … }` (erased at runtime);
    // `(?!\s+as\b)` after the helper rejects `{ defineAction as da }` (aliased away,
    // so no local `defineAction` value binding). Deeper shapes (inline `{ type x }`,
    // namespace `import * as core`) fall through to an advisory warning — the
    // graduation PR's CI typecheck is the authoritative gate for those.
    const helper = contract;
    const importRe = helper
      ? new RegExp(
          `\\bimport\\b(?!\\s+type\\b)[^;]*?\\b${escapeRegExp(helper)}\\b(?!\\s+as\\b)[^;]*?from\\s*["'\`]@linchkit\\/core["'\`]`,
          "g",
        )
      : IMPORT_CORE_RE;
    const importsCore = importIsReal(importRe);
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
