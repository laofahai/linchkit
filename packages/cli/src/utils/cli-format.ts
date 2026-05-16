/**
 * Shared CLI formatting helpers — table rendering, value parsing, prompts.
 *
 * Extracted so command files can stay under the 500 LOC limit and share a
 * single table renderer instead of each command reinventing column padding.
 */

import consola from "consola";

export interface Column<T> {
  header: string;
  width: number;
  get: (row: T) => string;
}

/** Right-pad a string to the requested width with spaces. */
export function padR(value: string, width: number): string {
  return value.length >= width ? `${value} ` : value + " ".repeat(width - value.length);
}

/** Truncate a string to `max` characters, appending `...` when shortened. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

/** Format a Date / ISO string into the canonical ISO 8601 form, empty when missing or invalid. */
export function fmtTimestamp(d: Date | string | undefined): string {
  if (!d) return "";
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

/** Render a fixed-width table to stdout using `console.log`. */
export function printTable<T>(rows: T[], columns: Column<T>[]): void {
  if (rows.length === 0) return;
  const header = columns.map((c) => padR(c.header, c.width)).join("  ");
  console.log(header);
  console.log(columns.map((c) => "-".repeat(c.width)).join("  "));
  for (const row of rows) {
    console.log(columns.map((c) => padR(c.get(row), c.width)).join("  "));
  }
}

/** Parse an ISO 8601 string into a Date. Throws when the input cannot be parsed. */
export function parseDateArg(label: string, raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid ISO date for ${label}: ${raw}`);
  }
  return d;
}

/**
 * Parse an integer-like CLI argument, falling back to the supplied default
 * when the input is empty. Throws on negative or non-numeric input.
 */
export function parseIntArg(label: string, raw: unknown, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid integer for ${label}: ${String(raw)}`);
  }
  return Math.trunc(n);
}

/** Split a comma-separated list into trimmed, non-empty tokens. */
export function parseCsvArg(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Prompt the user to confirm a mutation. `yes` short-circuits the prompt for
 * non-interactive callers (CI, scripts). Returns true only on explicit yes.
 */
export async function confirmAction(message: string, yes: boolean): Promise<boolean> {
  if (yes) return true;
  // consola.prompt returns the user's answer; the cast keeps tsc happy without
  // leaking `any` into the public interface.
  const answer = (await consola.prompt(message, {
    type: "confirm",
    initial: false,
  })) as boolean | undefined;
  return answer === true;
}
