/**
 * Shared helper for safely parsing JSON-string GraphQL arguments.
 *
 * Used across schema modules (build-schema, build-batch-mutation) so the
 * size limit and parse semantics stay consistent — duplication previously
 * lived in each module and drifted easily.
 */

import { GraphQLError } from "graphql";

/** Maximum allowed length for JSON string arguments. */
export const MAX_JSON_LENGTH = 10_000;

/**
 * Safely parse a JSON string argument with size validation.
 * Throws a `GraphQLError` for length / parse / shape violations.
 */
export function safeParseJSON(value: string, argName: string): Record<string, unknown> {
  if (value.length > MAX_JSON_LENGTH) {
    throw new GraphQLError(
      `Argument "${argName}" exceeds maximum allowed length of ${MAX_JSON_LENGTH} characters`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    // JSON.parse failed — convert to a user-facing GraphQL error
    throw new GraphQLError(`Argument "${argName}" contains invalid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new GraphQLError(`Argument "${argName}" must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}
