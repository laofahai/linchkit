/**
 * AutoForm type definitions.
 */
import type {
  EntityDefinition,
  RecordTemplate,
  RelationDefinition,
  ViewDefinition,
} from "@linchkit/core/types";
import type { AiFieldSuggestion } from "../../lib/ai-api";
import type { OnchangeFetcher } from "../../lib/onchange-dispatcher";
import type { FieldOverlayRecord } from "../../lib/overlay-types";

export type { RecordTemplate };

export interface ServerFieldErrors {
  [fieldName: string]: string;
}
export interface SubmitResult {
  fieldErrors?: ServerFieldErrors;
  formError?: string;
}
export interface VirtualRecord {
  _virtual: true;
  _tempId: string;
  [field: string]: unknown;
}
export type ChildCommand =
  | { type: "create"; tempId: string; values: Record<string, unknown> }
  | { type: "update"; id: string; values: Record<string, unknown> }
  | { type: "delete"; id: string };
export interface EnrichedSubmitData {
  values: Record<string, unknown>;
  virtualRefs: Record<string, VirtualRecord>;
  childCommands: Record<string, ChildCommand[]>;
}

export interface AutoFormProps {
  schema: EntityDefinition;
  view: ViewDefinition;
  data?: Record<string, unknown>;
  recordStatus?: string;
  formId?: string;
  onSubmit?: (
    data: Record<string, unknown>,
    enriched?: EnrichedSubmitData,
  ) => undefined | SubmitResult | Promise<undefined | SubmitResult | undefined>;
  onCancel?: () => void;
  onAction?: (actionName: string) => void;
  mode?: "create" | "edit" | "view";
  hideFooter?: boolean;
  serverErrors?: ServerFieldErrors;
  formError?: string;
  aiSuggestions?: Record<string, AiFieldSuggestion>;
  onAiAccept?: (fieldName: string) => void;
  onAiReject?: (fieldName: string) => void;
  onValuesChange?: (values: Record<string, unknown>) => void;
  registerSetField?: (setter: (fieldName: string, value: unknown) => void) => void;
  templates?: RecordTemplate[];
  overlayFields?: FieldOverlayRecord[];
  relations?: RelationDefinition[];
  onchangeDebounceMs?: number;
  onchangeFetcher?: OnchangeFetcher;
  onOnchangeWarnings?: (warnings: string[]) => void;
}
