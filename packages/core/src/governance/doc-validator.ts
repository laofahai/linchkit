/**
 * Documentation completeness validator
 *
 * Validates that schemas, actions, and capabilities have adequate documentation
 * coverage (descriptions, field docs, examples, etc.) per spec 37.
 */

import type { ActionDefinition } from "../types/action";
import type { CapabilityDefinition } from "../types/capability";
import type { FieldDefinition, SchemaDefinition } from "../types/schema";

// ── Types ────────────────────────────────────────────

export interface DocIssue {
  /** Severity: error = must fix, warning = should fix, info = nice to have */
  severity: "error" | "warning" | "info";
  /** Dot-path to the element with the issue (e.g. "fields.amount") */
  path: string;
  /** Human-readable description of the issue */
  message: string;
}

export interface DocCompleteness {
  /** Name of the validated element */
  name: string;
  /** Element type */
  type: "schema" | "action" | "capability";
  /** Coverage percentage (0-100): ratio of documented items to total items */
  coverage: number;
  /** Total documentable items */
  totalItems: number;
  /** Number of items with documentation */
  documentedItems: number;
  /** Individual issues found */
  issues: DocIssue[];
}

// ── Schema validation ────────────────────────────────

/**
 * Validate documentation completeness of a SchemaDefinition.
 *
 * Checks:
 * - Schema has description
 * - Schema has label
 * - Each field has description
 * - Each field has label
 * - Enum fields have option labels
 */
export function validateSchemaDoc(schema: SchemaDefinition): DocCompleteness {
  const issues: DocIssue[] = [];
  let totalItems = 0;
  let documentedItems = 0;

  // Schema-level description
  totalItems++;
  if (schema.description) {
    documentedItems++;
  } else {
    issues.push({
      severity: "error",
      path: "description",
      message: `Schema "${schema.name}" is missing a description`,
    });
  }

  // Schema-level label
  totalItems++;
  if (schema.label) {
    documentedItems++;
  } else {
    issues.push({
      severity: "warning",
      path: "label",
      message: `Schema "${schema.name}" is missing a label`,
    });
  }

  // Field-level documentation
  for (const [fieldName, field] of Object.entries(schema.fields)) {
    // Field description
    totalItems++;
    if (field.description) {
      documentedItems++;
    } else {
      issues.push({
        severity: "warning",
        path: `fields.${fieldName}.description`,
        message: `Field "${fieldName}" is missing a description`,
      });
    }

    // Field label
    totalItems++;
    if (field.label) {
      documentedItems++;
    } else {
      issues.push({
        severity: "info",
        path: `fields.${fieldName}.label`,
        message: `Field "${fieldName}" is missing a label`,
      });
    }

    // Enum option labels
    if (field.type === "enum") {
      const enumField = field as FieldDefinition & {
        type: "enum";
        options: Array<{ value: string; label?: string }>;
      };
      for (const option of enumField.options) {
        totalItems++;
        if (option.label) {
          documentedItems++;
        } else {
          issues.push({
            severity: "info",
            path: `fields.${fieldName}.options.${option.value}`,
            message: `Enum option "${option.value}" in field "${fieldName}" is missing a label`,
          });
        }
      }
    }
  }

  const coverage = totalItems === 0 ? 100 : Math.round((documentedItems / totalItems) * 100);

  return {
    name: schema.name,
    type: "schema",
    coverage,
    totalItems,
    documentedItems,
    issues,
  };
}

// ── Action validation ────────────────────────────────

/**
 * Validate documentation completeness of an ActionDefinition.
 *
 * Checks:
 * - Action has description
 * - Input fields have descriptions
 * - Output fields have descriptions
 */
export function validateActionDoc(action: ActionDefinition): DocCompleteness {
  const issues: DocIssue[] = [];
  let totalItems = 0;
  let documentedItems = 0;

  // Action-level description
  totalItems++;
  if (action.description) {
    documentedItems++;
  } else {
    issues.push({
      severity: "error",
      path: "description",
      message: `Action "${action.name}" is missing a description`,
    });
  }

  // Input field documentation
  if (action.input) {
    for (const [paramName, param] of Object.entries(action.input)) {
      totalItems++;
      if (param.description) {
        documentedItems++;
      } else {
        issues.push({
          severity: "warning",
          path: `input.${paramName}.description`,
          message: `Input parameter "${paramName}" is missing a description`,
        });
      }
    }
  }

  // Output field documentation
  if (action.output) {
    for (const [fieldName, field] of Object.entries(action.output)) {
      totalItems++;
      if (field.description) {
        documentedItems++;
      } else {
        issues.push({
          severity: "warning",
          path: `output.${fieldName}.description`,
          message: `Output field "${fieldName}" is missing a description`,
        });
      }
    }
  }

  const coverage = totalItems === 0 ? 100 : Math.round((documentedItems / totalItems) * 100);

  return {
    name: action.name,
    type: "action",
    coverage,
    totalItems,
    documentedItems,
    issues,
  };
}

// ── Capability validation ────────────────────────────

/**
 * Validate documentation completeness of a CapabilityDefinition.
 *
 * Checks:
 * - Capability has description
 * - All schemas within the capability are documented
 * - All actions within the capability are documented
 */
export function validateCapabilityDoc(manifest: CapabilityDefinition): DocCompleteness {
  const issues: DocIssue[] = [];
  let totalItems = 0;
  let documentedItems = 0;

  // Capability-level description
  totalItems++;
  if (manifest.description) {
    documentedItems++;
  } else {
    issues.push({
      severity: "error",
      path: "description",
      message: `Capability "${manifest.name}" is missing a description`,
    });
  }

  // Check each schema within the capability
  if (manifest.schemas) {
    for (const schema of manifest.schemas) {
      totalItems++;
      if (schema.description) {
        documentedItems++;
      } else {
        issues.push({
          severity: "warning",
          path: `schemas.${schema.name}.description`,
          message: `Schema "${schema.name}" in capability "${manifest.name}" is missing a description`,
        });
      }
    }
  }

  // Check each action within the capability
  if (manifest.actions) {
    for (const action of manifest.actions) {
      totalItems++;
      if (action.description) {
        documentedItems++;
      } else {
        issues.push({
          severity: "warning",
          path: `actions.${action.name}.description`,
          message: `Action "${action.name}" in capability "${manifest.name}" is missing a description`,
        });
      }
    }
  }

  const coverage = totalItems === 0 ? 100 : Math.round((documentedItems / totalItems) * 100);

  return {
    name: manifest.name,
    type: "capability",
    coverage,
    totalItems,
    documentedItems,
    issues,
  };
}
