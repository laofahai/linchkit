/**
 * AutoForm type definitions.
 */

import type { SchemaDefinition, ViewDefinition } from "@linchkit/core";

export interface AutoFormProps {
  schema: SchemaDefinition;
  view: ViewDefinition;
  data?: Record<string, unknown>;
  recordStatus?: string;
  onSubmit?: (data: Record<string, unknown>) => void;
  onCancel?: () => void;
  onAction?: (actionName: string) => void;
  mode?: "create" | "edit" | "view";
  /** Hide the built-in footer (Save/Cancel) — use when page provides its own buttons */
  hideFooter?: boolean;
}
