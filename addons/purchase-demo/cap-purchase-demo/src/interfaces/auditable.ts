/**
 * Auditable interface definition
 *
 * Provides standard audit trail fields that any schema can implement.
 * Fields: created_at, updated_at, created_by — injected automatically
 * into implementing schemas via InterfaceRegistry.
 *
 * Note: created_at, updated_at, created_by are system fields auto-added
 * by LinchKit to every schema. This interface makes the contract explicit
 * and adds semantic meaning (e.g., for MCP/AI agents to recognize
 * auditable entities).
 */

import { defineInterface } from "@linchkit/core";

export const auditableInterface = defineInterface({
  name: "auditable",
  label: "Auditable",
  description:
    "Provides audit trail fields (created_at, updated_at, created_by). " +
    "Schemas implementing this interface declare they participate in audit tracking.",
  fields: {
    audit_notes: {
      type: "text",
      label: "Audit Notes",
      description: "Optional notes recorded during auditable operations",
    },
  },
});
