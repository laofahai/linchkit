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
  | "ref"
  | "has_many"
  | "many_to_many"
  | "state"
  | "computed";

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

export interface RefField extends BaseFieldDefinition {
  type: "ref";
  target: string;
  readonly?: boolean;
}

export interface HasManyField extends BaseFieldDefinition {
  type: "has_many";
  target: string;
}

export interface ManyToManyField extends BaseFieldDefinition {
  type: "many_to_many";
  target: string;
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
  | RefField
  | HasManyField
  | ManyToManyField
  | StateField
  | ComputedField;

// ── Exposure control ──────────────────────────────────────

export interface ExposureConfig {
  graphql?: boolean;
  mcp?: boolean;
}

export type FieldExposureMap = Record<string, ExposureConfig>;

// ── Schema definition ──────────────────────────────────────

export interface SchemaDefinition<
  TFields extends Record<string, FieldDefinition> = Record<string, FieldDefinition>,
> {
  name: string;
  label?: string;
  description?: string;

  fields: TFields;

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
}
