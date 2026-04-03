/**
 * Convention checker — validates codebase conventions for commits,
 * schema definitions, and action definitions.
 *
 * Enforces Conventional Commits, snake_case schema names,
 * and verb_noun action naming per LinchKit spec 29.
 */

import { buildReport, type QualityIssue, type QualityReport } from "./code-quality";

// -- Types ---------------------------------------------------------------

export interface CommitInfo {
  hash?: string;
  message: string;
}

export interface SchemaInfo {
  name: string;
  fields?: Array<{ name: string; type?: string }>;
}

export interface ActionInfo {
  name: string;
  schema: string;
}

// -- Reserved words ------------------------------------------------------

/**
 * SQL / system reserved words that must not be used as schema names.
 */
const RESERVED_WORDS = new Set([
  "user",
  "users",
  "order",
  "orders",
  "group",
  "groups",
  "select",
  "insert",
  "update",
  "delete",
  "drop",
  "table",
  "index",
  "create",
  "alter",
  "from",
  "where",
  "join",
  "on",
  "and",
  "or",
  "not",
  "null",
  "true",
  "false",
  "default",
  "primary",
  "key",
  "foreign",
  "references",
  "constraint",
  "check",
  "unique",
  "schema",
  "database",
  "grant",
  "revoke",
  "role",
  "session",
  "transaction",
  "commit",
  "rollback",
]);

// -- Patterns ------------------------------------------------------------

const SNAKE_CASE_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const CONVENTIONAL_COMMIT_RE =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9\-_/]+\))?!?:\s.+/;

// -- Commit message validation -------------------------------------------

/**
 * Validate that commit messages follow Conventional Commits format.
 *
 * Expected: `type(scope): description`
 * Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert
 */
export function checkCommitMessages(commits: CommitInfo[]): QualityReport {
  const issues: QualityIssue[] = [];

  for (const commit of commits) {
    const firstLine = (commit.message.split("\n")[0] ?? "").trim();

    if (!firstLine) {
      issues.push({
        severity: "error",
        rule: "commit-message",
        message: `Empty commit message${commit.hash ? ` (${commit.hash})` : ""}`,
      });
      continue;
    }

    if (!CONVENTIONAL_COMMIT_RE.test(firstLine)) {
      issues.push({
        severity: "error",
        rule: "commit-message",
        message: `Commit message does not follow Conventional Commits: "${firstLine}"${commit.hash ? ` (${commit.hash})` : ""}`,
      });
      continue;
    }

    // Check description length (should be concise)
    if (firstLine.length > 100) {
      issues.push({
        severity: "warning",
        rule: "commit-message-length",
        message: `Commit message first line exceeds 100 chars (${firstLine.length})${commit.hash ? ` (${commit.hash})` : ""}`,
      });
    }
  }

  return buildReport(issues);
}

// -- Schema definition validation ----------------------------------------

/**
 * Validate schema naming conventions.
 *
 * Rules:
 * - Schema names: snake_case
 * - No reserved SQL/system words
 * - No plural names (should be singular)
 * - Field names: snake_case
 * - Boolean fields: should use is_ or has_ prefix
 * - Datetime fields: should use _at suffix
 */
export function checkEntityDefinitions(schemas: SchemaInfo[]): QualityReport {
  const issues: QualityIssue[] = [];

  for (const schema of schemas) {
    // Check schema name: snake_case
    if (!SNAKE_CASE_RE.test(schema.name)) {
      issues.push({
        severity: "error",
        rule: "schema-naming",
        message: `Schema name "${schema.name}" must use snake_case`,
      });
    }

    // Check reserved words
    if (RESERVED_WORDS.has(schema.name.toLowerCase())) {
      issues.push({
        severity: "error",
        rule: "schema-reserved",
        message: `Schema name "${schema.name}" is a reserved word`,
      });
    }

    // Check for plurals (simple heuristic: ends with 's' but not 'ss' or 'us' or 'is')
    if (
      schema.name.endsWith("s") &&
      !schema.name.endsWith("ss") &&
      !schema.name.endsWith("us") &&
      !schema.name.endsWith("is") &&
      !schema.name.endsWith("_status")
    ) {
      issues.push({
        severity: "warning",
        rule: "schema-singular",
        message: `Schema name "${schema.name}" appears to be plural; use singular form`,
      });
    }

    // Check field names
    if (schema.fields) {
      for (const field of schema.fields) {
        if (!SNAKE_CASE_RE.test(field.name)) {
          issues.push({
            severity: "error",
            rule: "field-naming",
            message: `Field "${field.name}" in schema "${schema.name}" must use snake_case`,
          });
        }

        // Boolean fields should have is_ or has_ prefix
        if (
          field.type === "boolean" &&
          !field.name.startsWith("is_") &&
          !field.name.startsWith("has_")
        ) {
          issues.push({
            severity: "warning",
            rule: "boolean-prefix",
            message: `Boolean field "${field.name}" in schema "${schema.name}" should use is_ or has_ prefix`,
          });
        }

        // Datetime fields should have _at suffix
        if (
          field.type === "datetime" &&
          !field.name.endsWith("_at") &&
          !field.name.endsWith("_date") &&
          !field.name.endsWith("_time")
        ) {
          issues.push({
            severity: "warning",
            rule: "datetime-suffix",
            message: `Datetime field "${field.name}" in schema "${schema.name}" should use _at suffix`,
          });
        }
      }
    }
  }

  return buildReport(issues);
}

// -- Action definition validation ----------------------------------------

/**
 * Validate action naming conventions.
 *
 * Rules:
 * - Action names: snake_case with verb_noun pattern
 * - Should not use generic CRUD verbs (create, update, delete, read, get)
 * - Schema reference must be snake_case
 */
export function checkActionDefinitions(actions: ActionInfo[]): QualityReport {
  const issues: QualityIssue[] = [];

  const GENERIC_VERBS = new Set(["create", "update", "delete", "read", "get", "set", "put"]);

  for (const action of actions) {
    // Check action name: snake_case
    if (!SNAKE_CASE_RE.test(action.name)) {
      issues.push({
        severity: "error",
        rule: "action-naming",
        message: `Action name "${action.name}" must use snake_case`,
      });
    }

    // Check verb_noun pattern (at least one underscore separating verb from noun)
    const parts = action.name.split("_");
    if (parts.length < 2) {
      issues.push({
        severity: "warning",
        rule: "action-verb-noun",
        message: `Action name "${action.name}" should follow verb_noun pattern (e.g., "submit_request")`,
      });
    }

    // Check for generic CRUD verbs
    if (parts.length >= 1 && GENERIC_VERBS.has(parts[0] as string)) {
      issues.push({
        severity: "warning",
        rule: "action-semantic-verb",
        message: `Action "${action.name}" uses generic verb "${parts[0]}"; prefer business-specific verbs (e.g., "approve", "submit", "reject")`,
      });
    }

    // Check schema reference
    if (!SNAKE_CASE_RE.test(action.schema)) {
      issues.push({
        severity: "error",
        rule: "action-schema-ref",
        message: `Action "${action.name}" references schema "${action.schema}" which is not snake_case`,
      });
    }
  }

  return buildReport(issues);
}
