/**
 * Schema type definitions
 *
 * Schema is the data foundation of LinchKit. All other concepts (Action, Rule, State, Event) revolve around Schema.
 * Define once, auto-generate Zod / Drizzle / TypeScript / GraphQL / JSON Schema.
 */

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
  | "computed"
  | "ref"
  | "has_many"
  | "many_to_many";

// ── Field constraints ──────────────────────────────────────────

export interface FieldConstraints {
  required?: boolean;
  unique?: boolean;
  min?: number;
  max?: number;
  format?: "email" | "url" | "phone" | "uuid" | (string & {});
  default?: unknown;
  immutable?: boolean;
}

// ── Field definitions ──────────────────────────────────────────

export interface BaseFieldDefinition extends FieldConstraints {
  type: FieldType;
  label?: string;
  description?: string;
  sensitive?: boolean;
  secret?: boolean;
  /** Whether this field stores translatable content (i18n). When true, values are stored as JSONB { locale: value }. */
  translatable?: boolean;
  /** Declarative UI hints for auto-layout and rendering */
  ui?: FieldUIHints;
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

export interface RefField extends BaseFieldDefinition {
  type: "ref";
  target: string;
}

export interface HasManyField extends BaseFieldDefinition {
  type: "has_many";
  target: string;
}

export interface ManyToManyField extends BaseFieldDefinition {
  type: "many_to_many";
  target: string;
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
  | ComputedField
  | RefField
  | HasManyField
  | ManyToManyField;

// ── Field-level UI hints ──────────────────────────────────

/** Field-level UI hints — declarative semantics, not component binding */
export interface FieldUIHints {
  /** Display priority: primary (list+summary), secondary (form main area), detail (collapsed) */
  importance?: "primary" | "secondary" | "detail";
  /** Value format hint: currency, percentage, filesize, duration */
  format?: "currency" | "percentage" | "filesize" | "duration";
  /** Display form hint: badge, progress, avatar, color, rating */
  display?: "badge" | "progress" | "avatar" | "color" | "rating";
  /** Semantic group name — fields with same group are placed together in auto-layout */
  group?: string;
  /** Form grid width hint (based on 12 columns), overrides type-inferred default */
  width?: 3 | 4 | 6 | 8 | 12;
}

// ── Schema presentation ──────────────────────────────────

/** Schema-level presentation metadata — tells the View layer how to understand and display this object */
export interface SchemaPresentation {
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
}

// ── Exposure control ──────────────────────────────────────

export interface ExposureConfig {
  graphql?: boolean;
  mcp?: boolean;
}

export type FieldExposureMap = Record<string, ExposureConfig>;

// ── Schema definition ──────────────────────────────────────

/** Internationalization configuration for a schema's translatable fields */
export interface SchemaI18nConfig {
  /** Default locale for this schema's translatable fields */
  defaultLocale?: string;
  /** Supported locales */
  supportedLocales?: string[];
}

export interface SchemaDefinition<
  TFields extends Record<string, FieldDefinition> = Record<string, FieldDefinition>,
> {
  name: string;
  label?: string;
  description?: string;

  fields: TFields;

  /** Presentation metadata for View layer auto-layout */
  presentation?: SchemaPresentation;

  /** Internationalization configuration for this schema */
  i18n?: SchemaI18nConfig;

  exposure?: ExposureConfig;
  fieldExposure?: FieldExposureMap;
}

// ── Schema extension and override ─────────────────────────────────

export interface SchemaExtension {
  fields: Record<string, FieldDefinition>;
}

export interface SchemaOverride {
  fields: Record<string, Partial<FieldConstraints>>;
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
export interface ResolvedSchema {
  /** Original schema name */
  name: string;
  /** Schema label */
  label?: string;
  /** Presentation metadata */
  presentation?: SchemaPresentation;
  /** All fields including system fields, keyed by field name */
  fields: Record<string, ResolvedField>;
  /** Original schema definition reference */
  source: SchemaDefinition;
}
