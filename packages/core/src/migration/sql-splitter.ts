/**
 * SQL Splitter — quote- and comment-aware tokenizer for migration files.
 *
 * Splits a SQL string into individual top-level statements.  The tokenizer
 * is a small character-by-character state machine that respects the SQL
 * constructs which can legally contain `;`, `--`, or block comment markers
 * without actually terminating or commenting a statement:
 *
 *   - single-quoted string literals `'...'` (with `''` escape)
 *   - double-quoted identifiers `"..."` (with `""` escape)
 *   - line comments `-- ... \n`
 *   - block comments
 *   - dollar-quoted strings `$$...$$` / `$tag$...$tag$` (Postgres `DO` blocks)
 *
 * Comments are stripped from the emitted statements.  Statements are split on
 * either the Drizzle marker `--> statement-breakpoint` (when present) or on
 * top-level `;` (otherwise).  This is a safe best-effort splitter for both
 * Drizzle-generated and hand-rolled migration files.
 */

const BREAKPOINT_MARKER = "--> statement-breakpoint";
const DOLLAR_TAG_RX = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

function tokenizeStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  const len = sql.length;
  let i = 0;

  const flush = (): void => {
    const trimmed = current.trim();
    if (trimmed.length > 0) statements.push(trimmed);
    current = "";
  };

  while (i < len) {
    const ch = sql[i];
    const next = i + 1 < len ? sql[i + 1] : "";

    // Drizzle breakpoint marker — only match at line start (after newline or BOF)
    if (
      ch === "-" &&
      next === "-" &&
      sql.startsWith(BREAKPOINT_MARKER, i) &&
      (i === 0 || sql[i - 1] === "\n" || sql[i - 1] === "\r")
    ) {
      flush();
      i += BREAKPOINT_MARKER.length;
      continue;
    }

    // Line comment — skip up to end of line, do not emit into current
    if (ch === "-" && next === "-") {
      i += 2;
      while (i < len && sql[i] !== "\n") i++;
      continue;
    }

    // Block comment — skip up to matching `*/`
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < len && !(sql[i] === "*" && i + 1 < len && sql[i + 1] === "/")) i++;
      if (i < len) i += 2; // consume closing `*/`
      continue;
    }

    // Single-quoted string literal
    if (ch === "'") {
      current += ch;
      i++;
      while (i < len) {
        const c = sql[i];
        current += c;
        i++;
        if (c === "'") {
          // Doubled single-quote `''` is an escaped quote, not a terminator
          if (i < len && sql[i] === "'") {
            current += sql[i];
            i++;
            continue;
          }
          break;
        }
      }
      continue;
    }

    // Double-quoted identifier
    if (ch === '"') {
      current += ch;
      i++;
      while (i < len) {
        const c = sql[i];
        current += c;
        i++;
        if (c === '"') {
          if (i < len && sql[i] === '"') {
            current += sql[i];
            i++;
            continue;
          }
          break;
        }
      }
      continue;
    }

    // Dollar-quoted string — `$$` or `$tag$`
    if (ch === "$") {
      const tagMatch = DOLLAR_TAG_RX.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0]; // includes leading and trailing `$`
        current += tag;
        i += tag.length;
        const endIdx = sql.indexOf(tag, i);
        if (endIdx === -1) {
          // Unterminated dollar quote — consume the rest verbatim
          current += sql.slice(i);
          i = len;
        } else {
          current += sql.slice(i, endIdx + tag.length);
          i = endIdx + tag.length;
        }
        continue;
      }
    }

    // Top-level statement terminator
    if (ch === ";") {
      flush();
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  flush();
  return statements;
}

/**
 * Split a Drizzle (or hand-written) migration file into individual SQL
 * statements.  Honours the Drizzle `--> statement-breakpoint` marker and
 * falls back to a quote- and comment-aware `;` splitter that correctly
 * handles string literals, identifiers, line/block comments, and
 * Postgres dollar-quoted `DO $$ ... $$` blocks.
 */
export function splitStatements(sql: string): string[] {
  return tokenizeStatements(sql);
}
