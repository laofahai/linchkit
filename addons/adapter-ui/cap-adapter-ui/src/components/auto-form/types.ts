/**
 * AutoForm type definitions.
 */

import type {
  EntityDefinition,
  RecordTemplate,
  RelationDefinition,
  ViewDefinition,
} from "@linchkit/core/types";
import type { AiFieldSuggestion } from "../../lib/api";
import type { OnchangeFetcher } from "../../lib/onchange-dispatcher";
import type { FieldOverlayRecord } from "../../lib/overlay-types";

export type { RecordTemplate };

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

/** A virtual record created in-memory (not yet persisted) */
export interface VirtualRecord {
  _virtual: true;
  _tempId: string;
  [field: string]: unknown;
}

/** Child record command for batch submission (Odoo-inspired) */
export type ChildCommand =
  | { type: "create"; tempId: string; values: Record<string, unknown> }
  | { type: "update"; id: string; values: Record<string, unknown> }
  | { type: "delete"; id: string };

/** Data payload emitted on form submit, enriched with virtual record metadata */
export interface EnrichedSubmitData {
  /** Regular form field values */
  values: Record<string, unknown>;
  /** Virtual ref records that need to be created first (field name -> virtual record) */
  virtualRefs: Record<string, VirtualRecord>;
  /** Child record commands for one_to_many relations (field name -> commands) */
  childCommands: Record<string, ChildCommand[]>;
}

export interface AutoFormProps {
  schema: EntityDefinition;
  view: ViewDefinition;
  data?: Record<string, unknown>;
  recordStatus?: string;
  /** Custom HTML form id — required when multiple AutoForms coexist on a page (e.g. dialog inside parent form) */
  formId?: string;
  /**
   * Called on form submit after client validation passes.
   * Return a SubmitResult to display server-side errors on the form.
   * Return void or undefined on success.
   */
  onSubmit?: (
    data: Record<string, unknown>,
    enriched?: EnrichedSubmitData,
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
  /**
   * Record templates to display as a pre-fill selector in create mode.
   * When provided and mode === "create", a TemplateSelector is shown above the form.
   */
  templates?: RecordTemplate[];
  /**
   * Runtime overlay fields for this entity. When provided, renders a
   * "Custom Fields" section after the main layout with overlay field inputs.
   * Values are stored in and read from the record's `_extensions` object.
   */
  overlayFields?: FieldOverlayRecord[];
  /**
   * Relation definitions for the entity. Used to identify virtual ref records
   * and child record commands by cardinality rather than field type (Spec 61).
   */
  relations?: RelationDefinition[];
  /**
   * Debounce window (ms) before posting an onchange request to the server.
   * Defaults to 300 ms (Spec 64 §6.1). Set to 0 in tests to fire immediately.
   */
  onchangeDebounceMs?: number;
  /**
   * Optional onchange request fetcher override (test seam). When omitted the
   * default `requestEntityOnchange` is used.
   */
  onchangeFetcher?: OnchangeFetcher;
  /**
   * Optional handler invoked with non-blocking warnings returned by an
   * onchange call. Defaults to logging via `console.warn`.
   */
  onOnchangeWarnings?: (warnings: string[]) => void;
}
