/**
 * GraphQL naming helpers — single source of truth for the graphql/ modules.
 *
 * IMPORTANT (producer/consumer contract): build-subscriptions.ts publishes
 * subscription fields named `on{Pascal}Created|Updated|Deleted` via
 * `toPascalCase`, and the UI subscribes to those fields BY NAME using its own
 * copy of this helper (addons/adapter-ui/cap-adapter-ui/src/lib/api.ts —
 * the UI must not import server code, so the copy cannot be shared).
 * Both implementations MUST produce identical output for entity names,
 * e.g. "purchase_request" → "PurchaseRequest". Pinned by unit tests on both
 * sides: __tests__/graphql-naming.test.ts (server) and
 * __tests__/subscription-naming.test.ts (cap-adapter-ui).
 */

/** Regex for valid GraphQL names */
export const GRAPHQL_NAME_RE = /^[_A-Za-z][_0-9A-Za-z]*$/;

/**
 * Raw PascalCase join of a snake_case/kebab-case name, WITHOUT GraphQL name
 * sanitization. Exposed so callers can detect whether sanitization changed
 * the result (see schema-to-graphql.ts warn path).
 */
export function joinPascal(name: string): string {
  return name
    .split(/[_-]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * Convert a snake_case/kebab-case name to PascalCase for GraphQL type names.
 * Strips characters not allowed in GraphQL names and ensures the result
 * starts with a letter or underscore.
 * e.g. "purchase_request" → "PurchaseRequest"
 */
export function toPascalCase(name: string): string {
  const sanitized = joinPascal(name).replace(/[^_0-9A-Za-z]/g, "");
  return GRAPHQL_NAME_RE.test(sanitized) ? sanitized : `_${sanitized}`;
}

/**
 * Convert a snake_case/kebab-case name to camelCase for GraphQL field names.
 * e.g. "purchase_request" → "purchaseRequest"
 */
export function toCamelCase(name: string): string {
  const pascal = toPascalCase(name);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}
