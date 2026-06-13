/**
 * patchNamedConstant — the concrete TypeScript-AST source patcher injected into
 * core's typescript-free `SourcePatcher` seam (#566, Option A).
 *
 * Core declares only the request/result shapes and the `SourcePatcher` function
 * type (`packages/core/src/types/source-patch.ts`); it never imports TypeScript.
 * This module ships the real implementation in `@linchkit/devtools` — which
 * already depends on `typescript` for capability-lint — and is wired into
 * `ProposalFileWriter` from outside core.
 *
 * It replaces the initializer of a top-level `export const <NAME>` declaration
 * in TypeScript source text. Locating the declaration via the compiler AST (not
 * regex) is what makes the patch precise: comments, string literals, substring
 * names (`X_2`), nested/in-function consts, and non-exported consts are all
 * correctly unmatchable, and every surrounding byte (indentation, the optional
 * `: number` annotation, the trailing `;`, trailing comments) is preserved
 * because only the initializer span is spliced out of the ORIGINAL source.
 */

import type { SourcePatchRequest, SourcePatchResult } from "@linchkit/core";
import * as ts from "typescript";

/**
 * A top-level `export const <constantName> = <initializer>` match, carrying the
 * byte span of its initializer in the original source.
 */
interface ConstantMatch {
  /** Inclusive start offset of the initializer in the original source. */
  start: number;
  /** Exclusive end offset of the initializer in the original source. */
  end: number;
}

/**
 * Returns true when the variable statement carries an `export` modifier.
 *
 * The `export` keyword lives directly on the statement's own modifiers, so we
 * read it from there. Inspecting `statement.modifiers` (instead of the first
 * declaration's combined modifier flags) avoids depending on parent pointers,
 * which lets the parse run with `setParentNodes: false`.
 */
function isExported(statement: ts.VariableStatement): boolean {
  return statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/**
 * Patch the value of a named top-level exported constant in TypeScript source.
 *
 * Conforms to core's `SourcePatcher` contract. On success returns the patched
 * source plus the replaced literal; returns `changed: false` ONLY for an
 * idempotent no-op (found, but the value already equals the target). THROWS
 * when the constant is not found, is ambiguous (more than one match — we refuse
 * to guess), or has no initializer.
 */
export function patchNamedConstant(request: SourcePatchRequest): SourcePatchResult {
  const { source, constantName, newValueLiteral } = request;

  // No parent pointers needed: `export` is read from the statement's own
  // modifiers, and `initializer.getStart(sourceFile)` is given the source file
  // explicitly, so `setParentNodes: false` keeps the parse lean.
  const sourceFile = ts.createSourceFile(
    "patch-input.ts",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
  );

  const matches: ConstantMatch[] = [];
  // True when a top-level `export const <name>` was found but had no
  // initializer (e.g. `export declare const X: number;`). Tracked separately so
  // we can throw NO INITIALIZER instead of a misleading NOT FOUND.
  let foundWithoutInitializer = false;

  // Walk ONLY the top-level statements. This is deliberate: consts declared
  // inside functions/blocks are never visited, so they stay unmatchable.
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    // `const`-only contract: `export let` / `export var` are deliberately NOT
    // patchable. The error messages and the SourcePatcher semantics all speak
    // of an `export const`, so a mutable binding must never match.
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
      continue;
    }
    if (!isExported(statement)) {
      continue;
    }

    for (const declaration of statement.declarationList.declarations) {
      // Match on the AST identifier — never on raw text — so comments, string
      // literals, and substring names (`X` vs `X_2`) cannot false-match.
      if (!ts.isIdentifier(declaration.name)) {
        continue;
      }
      if (declaration.name.text !== constantName) {
        continue;
      }

      const initializer = declaration.initializer;
      if (initializer === undefined) {
        foundWithoutInitializer = true;
        continue;
      }

      matches.push({
        // getStart(sourceFile) excludes leading trivia/comments; getEnd()
        // excludes trailing trivia — exactly the initializer's byte span.
        start: initializer.getStart(sourceFile),
        end: initializer.getEnd(),
      });
    }
  }

  if (matches.length > 1) {
    throw new Error(
      `AMBIGUOUS: found ${matches.length} top-level "export const ${constantName}" declarations; refusing to guess which to patch.`,
    );
  }

  const match = matches[0];
  if (!match) {
    if (foundWithoutInitializer) {
      throw new Error(
        `NO INITIALIZER: top-level "export const ${constantName}" has no initializer to patch.`,
      );
    }
    throw new Error(
      `NOT FOUND: no top-level "export const ${constantName}" declaration in source.`,
    );
  }

  const { start, end } = match;
  const oldValueLiteral = source.slice(start, end);

  // Idempotent no-op: the constant already holds the target value. This is the
  // ONLY case that returns `changed: false`; absence/ambiguity throw above. The
  // source is returned unchanged.
  if (oldValueLiteral === newValueLiteral) {
    return { source, oldValueLiteral, changed: false };
  }

  // Splice the ORIGINAL source: keep every byte outside the initializer span so
  // indentation, the `: number` annotation, the trailing `;`, and any trailing
  // comments survive untouched. The whole file is never re-emitted.
  const patched = source.slice(0, start) + newValueLiteral + source.slice(end);

  return { source: patched, oldValueLiteral, changed: true };
}
