/**
 * Identifier validation for LinchKit names (schemas, actions, capabilities, rules).
 *
 * LinchKit identifiers are used as TypeScript variable names and PostgreSQL
 * identifiers, so they must be safe for both contexts.
 */

/** Result of an identifier validation check. */
export interface IdentifierValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate a LinchKit identifier (schema name, action name, capability name, etc.).
 *
 * Rules:
 * - Must be non-empty
 * - Must be snake_case: lowercase letters, digits, underscores
 * - Must start with a letter
 * - Max 63 characters (PostgreSQL identifier limit)
 */
export function validateIdentifier(name: string): IdentifierValidationResult {
  if (!name) {
    return { valid: false, error: "Name is required" };
  }
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    return {
      valid: false,
      error:
        "Name must be snake_case: lowercase letters, digits, underscores, starting with a letter",
    };
  }
  if (name.length > 63) {
    return {
      valid: false,
      error: "Name must be 63 characters or less (PostgreSQL identifier limit)",
    };
  }
  return { valid: true };
}
