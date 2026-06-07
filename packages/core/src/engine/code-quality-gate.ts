/**
 * Code quality gate for AI-generated proposal source (G5 Phase 2).
 *
 * Validates the SYNTACTIC validity of generated TypeScript via Bun's transpiler.
 * It does NOT resolve types or imports — there is no project context at proposal
 * time, so a full project-aware typecheck would false-positive on every
 * reference to a project symbol. Syntactic validation catches the most common
 * LLM failure modes (truncated output, unbalanced braces, invalid tokens)
 * without those false positives. A full project-aware build pass is a deliberate
 * later enhancement.
 *
 * The check runs only on the Bun runtime (where generation happens). Off Bun
 * (e.g. a non-Bun consumer of the compiled npm package) it degrades to a no-op
 * so it can never throw or block — the worst case is "not syntax-checked here",
 * which the graduation PR's CI still catches.
 */

import type { QualityGateRunner } from "../ai/proposal-code-generator";

/** Minimal structural view of the Bun transpiler we rely on (avoids a hard @types/bun dep). */
interface BunTranspilerLike {
  transformSync(code: string): string;
}
interface BunLike {
  Transpiler: new (options: { loader: "ts" | "tsx" }) => BunTranspilerLike;
}

/** Resolve Bun's transpiler at runtime, or `null` when not running on Bun. */
function resolveBun(): BunLike | null {
  const candidate = (globalThis as { Bun?: BunLike }).Bun;
  return candidate && typeof candidate.Transpiler === "function" ? candidate : null;
}

/**
 * Synchronously check a source string for SYNTAX errors.
 *
 * Returns a list of human-readable error messages (empty = syntactically valid,
 * or skipped because Bun is unavailable). Never throws.
 */
export function checkSourceSyntax(source: string, filename = "generated.ts"): string[] {
  if (typeof source !== "string" || source.trim().length === 0) {
    return ["Generated source is empty."];
  }
  const bun = resolveBun();
  if (!bun) return []; // not on Bun → cannot syntax-check here; degrade to no-op.

  const loader: "ts" | "tsx" = filename.endsWith(".tsx") ? "tsx" : "ts";
  try {
    new bun.Transpiler({ loader }).transformSync(source);
    return [];
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
}

/**
 * Build a {@link QualityGateRunner} (async) over {@link checkSourceSyntax}, for
 * the proposal materializer's generate→check→retry loop. Each file is checked
 * independently; messages are prefixed with the file path.
 */
export function createSyntaxQualityGate(): QualityGateRunner {
  return {
    check(files: Record<string, string>): Promise<string[]> {
      const errors: string[] = [];
      for (const [path, source] of Object.entries(files)) {
        for (const message of checkSourceSyntax(source, path)) {
          errors.push(`${path}: ${message}`);
        }
      }
      return Promise.resolve(errors);
    },
  };
}
