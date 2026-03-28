/**
 * AutoForm type definitions.
 */

import type { SchemaDefinition, ViewDefinition } from "@linchkit/core/types";
import type { AiFieldSuggestion } from "../../lib/api";

/** Field-level errors returned from server validation */
export interface ServerFieldErrors {
  [fieldName: string]: string;
}

/** Structured submit result for server-side error propagation */
export interface SubmitResult {
  /** Per-field validation errors from server */
  fieldErrors?: ServerFieldErrors;
  /** General form-level error message */
  formError?: string;
}

export interface AutoFormProps {
  schema: SchemaDefinition;
  view: ViewDefinition;
  data?: Record<string, unknown>;
  recordStatus?: string;
  /**
   * Called on form submit after client validation passes.
   * Return a SubmitResult to display server-side errors on the form.
   * Return void or undefined on success.
   */
  onSubmit?: (
    data: Record<string, unknown>,
  ) => undefined | SubmitResult | Promise<undefined | SubmitResult | undefined>;
  onCancel?: () => void;
  onAction?: (actionName: string) => void;
  mode?: "create" | "edit" | "view";
  /** Hide the built-in footer (Save/Cancel) — use when page provides its own buttons */
  hideFooter?: boolean;
  /** External server-side errors to display (set by parent component) */
  serverErrors?: ServerFieldErrors;
  /** External form-level error message */
  formError?: string;
  /** AI suggestions keyed by field name */
  aiSuggestions?: Record<string, AiFieldSuggestion>;
  /** Callback when user accepts an AI suggestion for a field */
  onAiAccept?: (fieldName: string) => void;
  /** Callback when user rejects an AI suggestion for a field */
  onAiReject?: (fieldName: string) => void;
  /** Called whenever form values change — allows parent to track current values */
  onValuesChange?: (values: Record<string, unknown>) => void;
  /** Called once on mount — registers a setter so parent can programmatically set field values */
  registerSetField?: (setter: (fieldName: string, value: unknown) => void) => void;
}
