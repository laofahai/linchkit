/**
 * Schema type definitions
 *
 * Schema is the data foundation of LinchKit. All other concepts (Action, Rule, State, Event) revolve around Schema.
 * Define once, auto-generate Zod / Drizzle / TypeScript / GraphQL / JSON Schema.
 */

import type { OnchangeDefinition } from "./onchange";

// ── Field types ──────────────────────────────────────────

export type FieldType =
  | "string"
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "enum"
  | "json"
  | "state"
  | "computed";

// ── Field constraints ──────────────────────────────────────────

export interface FieldConstraints {
  required?: boolean;
  unique?: boolean;
  min?: number;
  max?: number;
  format?: "email" | "url" | "phone" | "uuid" | (string & {});
  /** Regex pattern for string field validation */
  pattern?: string;
  default?: unknown;
  /**
   * Field cannot be modified once it has been set to a non-null value.
   * Enforced by the Action Engine (Spec 63 §2.1):
   *  - First write (create or first non-null assignment): allowed
   *  - Writing the same value again: allowed (no-op)
   *  - Writing a different value after it is set: blocked
   *  - Writing `null` after it is set: blocked
   */
  immutable?: boolean;
}

// ── Lock conditions (Spec 63) ───────────────────────────────────

/**
 * Condition that determines whether a field is currently locked (readonly).
 * Spec 63 §3. Phase 1 supports state-based locking only; `domain` is reserved
 * for future complex locking scenarios and is ignored by the engine for now.
 */
export interface LockCondition {
  /**
   * Lock when the existing record's `status` field matches.
   *  - `"submitted"` — lock when status is exactly "submitted"
   *  - `["submitted", "approved"]` — lock when status is any of these
   *  - `{ not: "draft" }` — lock when status is anything except "draft"
   *  - `{ not: ["draft", "rejected"] }` — lock when status is none of these
   */
  state?: string | string[] | { not: string | string[] };
  /**
   * Lock when a field-based domain expression matches. Reserved for Phase 2+;
   * not evaluated by the Phase 1 engine.
   */
  domain?: Array<[string, string, unknown]>;
}

// ── Field masking configuration ──────────────────────────────────

export type MaskingStrategy = "full" | "partial" | "hash" | "redact";

export interface MaskingConfig {
  strategy: MaskingStrategy;
  /** For 'partial': number of characters to leave visible (default: 4) */
  visibleChars?: number;
  /** For 'partial': which end to keep visible (default: 'end') */
  position?: "start" | "end";
}

// ── Field definitions ──────────────────────────────────────────

export interface BaseFieldDefinition extends FieldConstraints {
  type: FieldType;
  label?: string;
  description?: string;
  sensitive?: boolean;
  secret?: boolean;
  /**
   * @deprecated Use `immutable: true` instead. At the field level `readonly`
   * is treated as an alias for `immutable` by the Action Engine (Spec 63 §8)
   * and will be removed in a future major version. View-level `readonly`
   * (in ViewDefinition) is NOT deprecated — it remains a UI-only display hint.
   */
  readonly?: boolean;
  /**
   * Conditional readonly — field is locked (unchangeable) when the condition
   * matches the existing record. Spec 63 §2.2. Evaluated on update actions
   * before pre-validation. Overrides the entity-level `lockAllWhen` for this
   * field.
   */
  lockWhen?: LockCondition;
  /** Data masking configuration. When set, field values are masked based on strategy unless actor has unmask permission. */
  masking?: MaskingConfig;
  /** Whether this field stores translatable content (i18n). When true, values are stored as JSONB { locale: value }. */
  translatable?: boolean;
  /** Declarative UI hints for auto-layout and rendering */
  ui?: FieldUIHints;
  /** Capability required for this field. Field is hidden when capability is absent. */
  requiresCapability?: string;
  /**
   * When true and the field is `required`, an empty string ("") is treated as
   * a present value rather than missing during NL intent reconciliation
   * (Spec 52). Defaults to false — the resolver continues to surface "" as a
   * missing required field for normal scalar inputs. Has no effect on `null`
   * or absent values, which are always treated as missing.
   */
  allowEmpty?: boolean;
  /** Derived field configuration (spec 48). When set, field value is computed, not user-input. */
  derived?: {
    /** Derivation type */
    type: "aggregate" | "expression" | "concat" | "function";
    /** Computation strategy. 'store' persists to DB (default), 'compute' calculates on read. */
    strategy?: "store" | "compute";
    /** Fields this derivation depends on (for triggering recalculation) */
    deps?: string[];
    // Type-specific config — will be fully defined in spec 48 implementation
    [key: string]: unknown;
  };
}

export interface StringField extends BaseFieldDefinition {
  type: "string";
}

export interface TextField extends BaseFieldDefinition {
  type: "text";
}

export interface NumberField extends BaseFieldDefinition {
  type: "number";
}

export interface BooleanField extends BaseFieldDefinition {
  type: "boolean";
}

export interface DateField extends BaseFieldDefinition {
  type: "date";
}

export interface DateTimeField extends BaseFieldDefinition {
  type: "datetime";
}

export interface EnumField extends BaseFieldDefinition {
  type: "enum";
  options: Array<{ value: string; label?: string }>;
}

export interface JsonField extends BaseFieldDefinition {
  type: "json";
}

export interface StateField extends BaseFieldDefinition {
  type: "state";
  machine: string;
}

export interface ComputedField extends BaseFieldDefinition {
  type: "computed";
  compute: (record: Record<string, unknown>) => unknown;
}

export type FieldDefinition =
  | StringField
  | TextField
  | NumberField
  | BooleanField
  | DateField
  | DateTimeField
  | EnumField
  | JsonField
  | StateField
  | ComputedField;

// ── Field-level UI hints ──────────────────────────────────

/** Field-level UI hints — declarative semantics, not component binding */
export interface FieldUIHints {
  /** Display priority: primary (list+summary), secondary (form main area), detail (collapsed) */
  importance?: "primary" | "secondary" | "detail";
  /** Value format hint: currency, percentage, filesize, duration */
  format?: "currency" | "percentage" | "filesize" | "duration";
  /** Display form hint: badge, progress, avatar, color, rating */
  display?: "badge" | "progress" | "avatar" | "color" | "rating";
  /** Editor variant hint: e.g. "rich" for rich-text editor on text fields */
  editor?: "rich";
  /** Semantic group name — fields with same group are placed together in auto-layout */
  group?: string;
  /** Form grid width hint (based on 12 columns), overrides type-inferred default */
  width?: 3 | 4 | 6 | 8 | 12;
  /** Show as State Ribbon primary in list views */
  ribbonPrimary?: boolean;
}

// ── Schema presentation ──────────────────────────────────

/** Schema-level presentation metadata — tells the View layer how to understand and display this object */
export interface EntityPresentation {
  /** Field name used as object title (cards, search results, breadcrumbs) */
  titleField?: string;
  /** Field name used as subtitle */
  subtitleField?: string;
  /** Field name used as status/category badge */
  badgeField?: string;
  /** Key indicator fields (max 3-4, used in cards, workspace summaries) */
  summaryFields?: string[];
  /** Lucide icon name (used in navigation, search results) */
  icon?: string;
  /** State Ribbon config for list views (spec 03 section 5b) */
  stateRibbon?: {
    enabled: boolean;
    field: string;
  };
}

// ── Exposure control ──────────────────────────────────────

export interface ExposureConfig {
  graphql?: boolean;
  mcp?: boolean;
}

export type FieldExposureMap = Record<string, ExposureConfig>;

// ── Schema Interface ──────────────────────────────────────

/** Interface action template — metadata only, handler provided by implementing schema */
export interface InterfaceActionTemplate {
  label: string;
  requiredFields?: string[];
  description?: string;
}

/** Interface state machine template */
export interface InterfaceStateTemplate {
  initial: string;
  transitions: Array<{
    from: string;
    to: string;
    action: string;
  }>;
}

/**
 * Schema Interface — a contract that multiple schemas can implement.
 * Defines required fields, optional state machine template, and action templates.
 * See spec: docs/specs/47_schema_interface.md
 */
export interface InterfaceDefinition {
  /** Unique identifier */
  name: string;
  /** Human-readable label */
  label: string;
  /** Description of what this interface provides */
  description?: string;
  /** Required fields — injected into implementing schemas */
  fields: Record<string, FieldDefinition>;
  /** Optional state machine template */
  state?: InterfaceStateTemplate;
  /** Optional action templates (metadata only, no handler) */
  actions?: Record<string, InterfaceActionTemplate>;
}

// ── Schema AI configuration ──────────────────────────────────

/**
 * Per-schema AI behavior configuration (spec 52 §8.2).
 * Controls what AI features are available for this schema.
 */
export interface EntityAIConfig {
  /** Whether AI can read records of this schema for analysis/context (default: true) */
  readable?: boolean;
  /** Whether AI can propose actions on this schema (default: true) */
  actionable?: boolean;
  /** Whether AI can include this schema in search results (default: true) */
  searchable?: boolean;
  /** Specific fields to exclude from AI context */
  excludeFields?: string[];
  /** Custom AI instructions for this schema */
  instructions?: string;
}

// ── Schema definition ──────────────────────────────────────

/** Internationalization configuration for a schema's translatable fields */
export interface EntityI18nConfig {
  /** Default locale for this schema's translatable fields */
  defaultLocale?: string;
  /** Supported locales */
  supportedLocales?: string[];
}

export interface EntityDefinition<
  TFields extends Record<string, FieldDefinition> = Record<string, FieldDefinition>,
> {
  name: string;
  label?: string;
  description?: string;

  /** Parent schema name (single inheritance). Child inherits all parent fields. */
  extends?: string;

  /** When true, schema cannot be instantiated directly (no DB table, no create action). */
  abstract?: boolean;

  /** Interface names this schema implements. Fields from interfaces are auto-injected. */
  implements?: string[];

  fields: TFields;

  /** Presentation metadata for View layer auto-layout */
  presentation?: EntityPresentation;

  /** Internationalization configuration for this entity */
  i18n?: EntityI18nConfig;

  exposure?: ExposureConfig;
  fieldExposure?: FieldExposureMap;
  /** AI behavior configuration for this entity (spec 52 §8.2) */
  ai?: EntityAIConfig;

  /**
   * Interactive form computation hooks (Spec 64).
   * Keys are either a single field name or a comma-separated list of field names.
   * A hook fires while the user is editing a form; it never runs on the write path.
   */
  onchange?: Record<string, OnchangeDefinition>;

  /**
   * Entity-wide lock (Spec 63 §2.2 `__all__` shorthand). When the condition
   * matches the existing record, ALL fields are locked except those listed
   * in `lockAllowFields`. Per-field `lockWhen` takes precedence.
   */
  lockAllWhen?: LockCondition;
  /**
   * Fields exempt from `lockAllWhen`. Typical use: keep notes/tags/comments
   * editable even when the record as a whole is locked.
   */
  lockAllowFields?: string[];
}

// ── Schema extension and override ─────────────────────────────────

export interface EntityExtension {
  fields: Record<string, FieldDefinition>;
}

/**
 * Overridable field properties — the subset of {@link BaseFieldDefinition}
 * (excluding `type`, which must never change across an override) that
 * overlays may modify. Covers legacy `FieldConstraints` (required/unique/
 * min/max/format/pattern/default/immutable) plus the Spec 63 additions
 * `readonly` and `lockWhen`, so tenant/capability overlays can tighten or
 * add lock rules at runtime.
 */
export type FieldOverrideProps = Partial<FieldConstraints> & {
  readonly?: boolean;
  lockWhen?: LockCondition;
};

export interface EntityOverride {
  fields: Record<string, FieldOverrideProps>;
}

// ── System fields (automatically included in every Schema) ────────────────

export interface SystemFields {
  id: string;
  tenant_id: string;
  created_at: Date;
  updated_at: Date;
  created_by: string;
  updated_by: string;
  _version: number;
  deleted_at: string | null;
}

// ── Resolved schema types ────────────────────────────────────────────────

/** A field with resolution metadata */
export interface ResolvedField {
  /** Original field definition */
  definition: FieldDefinition;
  /** Whether this field is stored in DB (false for computed) */
  storable: boolean;
  /** Resolved label (from definition or generated from name) */
  label: string;
}

/** Schema after Registry processing — system fields injected, extensions merged */
export interface ResolvedEntity {
  /** Original schema name */
  name: string;
  /** Schema label */
  label?: string;
  /** Whether this schema is abstract (cannot be instantiated) */
  abstract?: boolean;
  /** Whether this schema is system-internal (read-only, managed by core) */
  internal?: boolean;
  /** Parent schema name, if this schema extends another */
  parent?: string;
  /** Child schema names that extend this schema */
  children: string[];
  /** Interface names this schema implements */
  implements?: string[];
  /** Presentation metadata */
  presentation?: EntityPresentation;
  /** All fields including system fields, keyed by field name */
  fields: Record<string, ResolvedField>;
  /** Original schema definition reference */
  source: EntityDefinition;
}
