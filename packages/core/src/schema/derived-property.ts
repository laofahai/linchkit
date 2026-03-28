/**
 * Derived Property Engine (spec 48)
 *
 * Provides safe expression evaluation and runtime resolution of derived fields.
 * Derived fields compute their values from other fields, rather than user input.
 *
 * Types:
 * - expression: arithmetic/logic on fields within the same record
 * - concat: string concatenation of multiple fields
 * - function: custom compute function
 * - aggregate: cross-record aggregation via Link system (SUM, COUNT, AVG, MIN, MAX)
 *
 * Strategies:
 * - store: persisted to DB, recalculated on write (default)
 * - compute: calculated on read, not persisted
 */

import type { DataProvider } from "../engine/action-engine";
import type { LinkDefinition, LinkRegistryInterface } from "../types/link";
import type { FieldDefinition, SchemaDefinition } from "../types/schema";

// ── Derived field type definitions ────────────────────────────

/** Expression-based derivation: arithmetic/logic on same-record fields */
export interface ExpressionDerived {
  type: "expression";
  /** Expression string, e.g. "amount * quantity", "price - discount" */
  expr: string;
  strategy?: "store" | "compute";
  deps?: string[];
}

/** String concatenation derivation */
export interface ConcatDerived {
  type: "concat";
  /** Field names to concatenate */
  fields: string[];
  /** Separator between values (default: "") */
  separator?: string;
  strategy?: "store" | "compute";
  deps?: string[];
}

/** Custom function derivation */
export interface FunctionDerived {
  type: "function";
  /** Compute function — receives the record, returns the derived value */
  compute: (record: Record<string, unknown>) => unknown;
  strategy?: "store" | "compute";
  deps?: string[];
}

/** Aggregate derivation: cross-record aggregation via Link system */
export interface AggregateDerived {
  type: "aggregate";
  source: { link: string; schema: string; filter?: Record<string, unknown> };
  op: "sum" | "count" | "avg" | "min" | "max";
  field?: string;
  strategy?: "store" | "compute";
  deps?: string[];
}

export type DerivedConfig = ExpressionDerived | ConcatDerived | FunctionDerived | AggregateDerived;

// ── Safe expression evaluator ─────────────────────────────────

/**
 * Tokenize an expression string into numbers, operators, parentheses, and field references.
 *
 * Supported tokens:
 * - Numbers (including decimals): 42, 3.14
 * - Field references (identifiers): amount, total_price
 * - Operators: +, -, *, /, %, >, <, >=, <=, ==, !=, &&, ||, !
 * - Parentheses: (, )
 * - Ternary: ?, :
 */
type TokenType =
  | "number"
  | "identifier"
  | "operator"
  | "lparen"
  | "rparen"
  | "ternary_question"
  | "ternary_colon";

interface Token {
  type: TokenType;
  value: string;
}

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = expr.length;

  while (i < len) {
    const ch = expr.charAt(i);

    // Whitespace
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Numbers
    if (/[0-9]/.test(ch) || (ch === "." && i + 1 < len && /[0-9]/.test(expr.charAt(i + 1)))) {
      let num = "";
      while (i < len && /[0-9.]/.test(expr.charAt(i))) {
        num += expr.charAt(i);
        i++;
      }
      tokens.push({ type: "number", value: num });
      continue;
    }

    // Identifiers (field references)
    if (/[a-zA-Z_$]/.test(ch)) {
      let id = "";
      while (i < len && /[a-zA-Z0-9_$]/.test(expr.charAt(i))) {
        id += expr.charAt(i);
        i++;
      }
      // Boolean literals
      if (id === "true" || id === "false") {
        tokens.push({ type: "number", value: id === "true" ? "1" : "0" });
      } else {
        tokens.push({ type: "identifier", value: id });
      }
      continue;
    }

    // Two-character operators
    if (i + 1 < len) {
      const two = expr.charAt(i) + expr.charAt(i + 1);
      if ([">=", "<=", "==", "!=", "&&", "||"].includes(two)) {
        tokens.push({ type: "operator", value: two });
        i += 2;
        continue;
      }
    }

    // Single-character operators
    if (["+", "-", "*", "/", "%", ">", "<", "!"].includes(ch)) {
      tokens.push({ type: "operator", value: ch });
      i++;
      continue;
    }

    // Parentheses
    if (ch === "(") {
      tokens.push({ type: "lparen", value: "(" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "rparen", value: ")" });
      i++;
      continue;
    }

    // Ternary
    if (ch === "?") {
      tokens.push({ type: "ternary_question", value: "?" });
      i++;
      continue;
    }
    if (ch === ":") {
      tokens.push({ type: "ternary_colon", value: ":" });
      i++;
      continue;
    }

    throw new Error(`[derived-property] Unexpected character '${ch}' in expression: ${expr}`);
  }

  return tokens;
}

/**
 * Recursive descent parser / evaluator for safe arithmetic + comparison expressions.
 *
 * Precedence (lowest to highest):
 * 1. Ternary: ? :
 * 2. Logical OR: ||
 * 3. Logical AND: &&
 * 4. Comparison: ==, !=, >, <, >=, <=
 * 5. Addition: +, -
 * 6. Multiplication: *, /, %
 * 7. Unary: -, !
 * 8. Primary: numbers, identifiers, parenthesized expressions
 */
class ExpressionParser {
  private tokens: Token[];
  private pos = 0;
  private record: Record<string, unknown>;

  constructor(tokens: Token[], record: Record<string, unknown>) {
    this.tokens = tokens;
    this.record = record;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private advance(): Token {
    const tok = this.tokens[this.pos];
    if (!tok) {
      throw new Error("[derived-property] Unexpected end of expression");
    }
    this.pos++;
    return tok;
  }

  private match(type: TokenType, value?: string): boolean {
    const tok = this.peek();
    if (!tok) return false;
    if (tok.type !== type) return false;
    if (value !== undefined && tok.value !== value) return false;
    return true;
  }

  parse(): number {
    const result = this.parseTernary();
    if (this.pos < this.tokens.length) {
      const leftover = this.tokens[this.pos];
      throw new Error(
        `[derived-property] Unexpected token: ${leftover ? leftover.value : "unknown"}`,
      );
    }
    return result;
  }

  private parseTernary(): number {
    const condition = this.parseOr();
    if (this.match("ternary_question")) {
      this.advance(); // consume ?
      const thenVal = this.parseTernary();
      if (!this.match("ternary_colon")) {
        throw new Error("[derived-property] Expected ':' in ternary expression");
      }
      this.advance(); // consume :
      const elseVal = this.parseTernary();
      return condition ? thenVal : elseVal;
    }
    return condition;
  }

  private parseOr(): number {
    let left = this.parseAnd();
    while (this.match("operator", "||")) {
      this.advance();
      const right = this.parseAnd();
      left = left || right ? 1 : 0;
    }
    return left;
  }

  private parseAnd(): number {
    let left = this.parseComparison();
    while (this.match("operator", "&&")) {
      this.advance();
      const right = this.parseComparison();
      left = left && right ? 1 : 0;
    }
    return left;
  }

  private parseComparison(): number {
    let left = this.parseAddition();
    const compOps = ["==", "!=", ">", "<", ">=", "<="];
    let current = this.peek();
    while (current && current.type === "operator" && compOps.includes(current.value)) {
      const op = this.advance().value;
      const right = this.parseAddition();
      switch (op) {
        case "==":
          left = left === right ? 1 : 0;
          break;
        case "!=":
          left = left !== right ? 1 : 0;
          break;
        case ">":
          left = left > right ? 1 : 0;
          break;
        case "<":
          left = left < right ? 1 : 0;
          break;
        case ">=":
          left = left >= right ? 1 : 0;
          break;
        case "<=":
          left = left <= right ? 1 : 0;
          break;
      }
      current = this.peek();
    }
    return left;
  }

  private parseAddition(): number {
    let left = this.parseMultiplication();
    let current = this.peek();
    while (
      current &&
      current.type === "operator" &&
      (current.value === "+" || current.value === "-")
    ) {
      const op = this.advance().value;
      const right = this.parseMultiplication();
      left = op === "+" ? left + right : left - right;
      current = this.peek();
    }
    return left;
  }

  private parseMultiplication(): number {
    let left = this.parseUnary();
    let current = this.peek();
    while (
      current &&
      current.type === "operator" &&
      (current.value === "*" || current.value === "/" || current.value === "%")
    ) {
      const op = this.advance().value;
      const right = this.parseUnary();
      if (op === "*") left *= right;
      else if (op === "/") {
        if (right === 0) {
          left = 0;
        } else {
          left /= right;
        }
      } else {
        if (right === 0) {
          left = 0;
        } else {
          left %= right;
        }
      }
      current = this.peek();
    }
    return left;
  }

  private parseUnary(): number {
    if (this.match("operator", "-")) {
      this.advance();
      return -this.parseUnary();
    }
    if (this.match("operator", "!")) {
      this.advance();
      return this.parseUnary() ? 0 : 1;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    const tok = this.peek();
    if (!tok) {
      throw new Error("[derived-property] Unexpected end of expression");
    }

    if (tok.type === "number") {
      this.advance();
      return Number.parseFloat(tok.value);
    }

    if (tok.type === "identifier") {
      this.advance();
      const val = this.record[tok.value];
      if (val === null || val === undefined) return 0;
      if (typeof val === "boolean") return val ? 1 : 0;
      const num = Number(val);
      if (Number.isNaN(num)) return 0;
      return num;
    }

    if (tok.type === "lparen") {
      this.advance(); // consume (
      const result = this.parseTernary();
      if (!this.match("rparen")) {
        throw new Error("[derived-property] Expected closing parenthesis");
      }
      this.advance(); // consume )
      return result;
    }

    throw new Error(`[derived-property] Unexpected token: ${tok.value}`);
  }
}

/**
 * Safely evaluate an arithmetic/comparison expression against a record.
 *
 * Uses a recursive descent parser — no eval() or Function constructor.
 * Field references are resolved from the record. Unknown fields resolve to 0.
 *
 * @param expr - Expression string, e.g. "amount * quantity - discount"
 * @param record - The record whose fields are referenced
 * @returns The numeric result
 */
export function evaluateExpression(expr: string, record: Record<string, unknown>): number {
  const tokens = tokenize(expr);
  if (tokens.length === 0) return 0;
  const parser = new ExpressionParser(tokens, record);
  return parser.parse();
}

// ── Derived field resolution ──────────────────────────────────

/**
 * Resolve a single derived field value for a record (synchronous).
 * For aggregate type, returns undefined — use resolveAggregateValue() instead.
 *
 * @param derived - The derived configuration from the field definition
 * @param record - The current record data
 * @returns The computed value, or undefined if cannot compute (e.g. aggregate without data provider)
 */
export function resolveDerivedValue(
  derived: DerivedConfig,
  record: Record<string, unknown>,
): unknown {
  switch (derived.type) {
    case "expression":
      return evaluateExpression(derived.expr, record);

    case "concat": {
      const sep = derived.separator ?? "";
      return derived.fields
        .map((f) => {
          const v = record[f];
          return v === null || v === undefined ? "" : String(v);
        })
        .filter((s) => s !== "")
        .join(sep);
    }

    case "function":
      return derived.compute(record);

    case "aggregate":
      // Aggregate requires async data provider access — use resolveAggregateValue()
      return undefined;

    default:
      return undefined;
  }
}

/**
 * Resolve an aggregate derived field value by querying related records via the data provider.
 *
 * Determines the FK column from the link definition and queries all related records,
 * then computes the aggregate operation (sum, count, avg, min, max).
 *
 * @param derived - The aggregate derived configuration
 * @param record - The parent record (must have an `id` field)
 * @param link - The link definition connecting parent to child schema
 * @param dataProvider - Data provider for querying related records
 * @returns The aggregated value
 */
export async function resolveAggregateValue(
  derived: AggregateDerived,
  record: Record<string, unknown>,
  link: LinkDefinition,
  dataProvider: DataProvider,
): Promise<number> {
  const parentId = record.id as string;
  if (!parentId) return 0;

  // Determine the FK column name and query direction based on link cardinality.
  // The parent schema is on the side that "has" the aggregate (i.e., the "from" side
  // of one_to_many, or the "to" side of many_to_one).
  const childSchema = derived.source.schema;
  let fkColumn: string;

  if (link.from === childSchema) {
    // Link: child → parent, FK is on the child table: `{parent}_id`
    fkColumn = `${link.to}_id`;
  } else {
    // Link: parent → child, FK is on the child table: `{parent}_id`
    fkColumn = `${link.from}_id`;
  }

  // Build filter: FK column matches parent ID + any user-specified filter
  const filter: Record<string, unknown> = { [fkColumn]: parentId };
  if (derived.source.filter) {
    Object.assign(filter, derived.source.filter);
  }

  const relatedRecords = await dataProvider.query(childSchema, filter);

  return computeAggregate(derived.op, derived.field, relatedRecords);
}

/**
 * Compute an aggregate operation on an array of records.
 */
export function computeAggregate(
  op: AggregateDerived["op"],
  field: string | undefined,
  records: Array<Record<string, unknown>>,
): number {
  if (op === "count") {
    return records.length;
  }

  if (!field) return 0;

  const values = records
    .map((r) => {
      const v = r[field];
      if (v === null || v === undefined) return undefined;
      const num = Number(v);
      return Number.isNaN(num) ? undefined : num;
    })
    .filter((v): v is number => v !== undefined);

  if (values.length === 0) return 0;

  switch (op) {
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "avg":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
    default:
      return 0;
  }
}

// ── DerivedPropertyEngine ─────────────────────────────────────

/** Information about a derived field registered in the engine */
export interface DerivedFieldInfo {
  schemaName: string;
  fieldName: string;
  fieldDefinition: FieldDefinition;
  derived: DerivedConfig;
  strategy: "store" | "compute";
}

/** Information about a cascade target: which parent schema/field to recalculate */
export interface CascadeTarget {
  /** Parent schema that has the aggregate derived field */
  parentSchema: string;
  /** Field name on the parent schema that needs recalculation */
  parentField: string;
  /** The aggregate derived config */
  derived: AggregateDerived;
  /** The link definition connecting child to parent */
  link: LinkDefinition;
  /** FK column name on the child record pointing to the parent */
  fkColumn: string;
}

/**
 * Parse the `derived` property from a FieldDefinition into a typed DerivedConfig.
 * Returns undefined if the field has no derived config or the type is unrecognized.
 */
function parseDerivedConfig(field: FieldDefinition): DerivedConfig | undefined {
  const raw = field.derived;
  if (!raw) return undefined;

  const derivedType = raw.type;

  switch (derivedType) {
    case "expression":
      return {
        type: "expression",
        expr: raw.expr as string,
        strategy: raw.strategy,
        deps: raw.deps,
      };
    case "concat":
      return {
        type: "concat",
        fields: raw.fields as string[],
        separator: raw.separator as string | undefined,
        strategy: raw.strategy,
        deps: raw.deps,
      };
    case "function":
      return {
        type: "function",
        compute: raw.compute as (record: Record<string, unknown>) => unknown,
        strategy: raw.strategy,
        deps: raw.deps,
      };
    case "aggregate":
      return {
        type: "aggregate",
        source: raw.source as { link: string; schema: string; filter?: Record<string, unknown> },
        op: raw.op as "sum" | "count" | "avg" | "min" | "max",
        field: raw.field as string | undefined,
        strategy: raw.strategy,
        deps: raw.deps,
      };
    default:
      return undefined;
  }
}

/**
 * DerivedPropertyEngine manages derived field resolution across schemas.
 *
 * It scans schema definitions, collects derived fields, builds a dependency
 * graph, detects cycles, and provides methods to resolve derived values
 * for records.
 *
 * Supports cross-schema aggregate computations (SUM, COUNT, AVG, MIN, MAX)
 * via Link system integration, with cascade recalculation when related records change.
 */
export class DerivedPropertyEngine {
  /** All registered derived fields, keyed by "schema.field" */
  private fields = new Map<string, DerivedFieldInfo>();

  /** Dependency graph: "schema.field" → set of "schema.field" it depends on */
  private depGraph = new Map<string, Set<string>>();

  /** Topological order for store-strategy fields (schema-scoped) */
  private topoOrder = new Map<string, string[]>();

  /** Cascade targets: child schema name → list of parent aggregate fields to recalculate */
  private cascadeMap = new Map<string, CascadeTarget[]>();

  /** Optional link registry for aggregate resolution */
  private linkRegistry?: LinkRegistryInterface;

  /** Optional data provider for aggregate resolution */
  private dataProvider?: DataProvider;

  /**
   * Wire the engine with a link registry and data provider for aggregate support.
   * Call this after register() once the link registry and data provider are available.
   */
  wire(options: { linkRegistry?: LinkRegistryInterface; dataProvider?: DataProvider }): void {
    this.linkRegistry = options.linkRegistry;
    this.dataProvider = options.dataProvider;
    // Rebuild cascade map now that we have the link registry
    if (this.linkRegistry) {
      this.buildCascadeMap();
    }
  }

  /**
   * Register all derived fields from a set of schema definitions.
   * Call this once during startup after all schemas are registered.
   *
   * @throws Error if circular dependencies are detected
   */
  register(schemas: SchemaDefinition[]): void {
    this.fields.clear();
    this.depGraph.clear();
    this.topoOrder.clear();
    this.cascadeMap.clear();

    // Phase 1: collect derived fields
    for (const schema of schemas) {
      for (const [fieldName, field] of Object.entries(schema.fields)) {
        const derived = parseDerivedConfig(field);
        if (!derived) continue;

        const key = `${schema.name}.${fieldName}`;
        const strategy = derived.strategy ?? "store";

        this.fields.set(key, {
          schemaName: schema.name,
          fieldName,
          fieldDefinition: field,
          derived,
          strategy,
        });

        // Build dependency edges (within same schema only for non-aggregate types)
        const deps = new Set<string>();
        const depFieldNames = this.getDependencyFieldNames(derived);
        for (const dep of depFieldNames) {
          deps.add(`${schema.name}.${dep}`);
        }
        this.depGraph.set(key, deps);
      }
    }

    // Phase 2: cycle detection + topological sort per schema
    this.buildTopoOrder(schemas);

    // Phase 3: build cascade map if link registry is available
    if (this.linkRegistry) {
      this.buildCascadeMap();
    }
  }

  /**
   * Build the cascade map: for each aggregate derived field, record which
   * child schema changes should trigger recalculation of the parent field.
   */
  private buildCascadeMap(): void {
    this.cascadeMap.clear();
    if (!this.linkRegistry) return;

    for (const info of this.fields.values()) {
      if (info.derived.type !== "aggregate") continue;

      const agg = info.derived;
      const linkName = agg.source.link;
      const childSchema = agg.source.schema;

      // Find the link definition
      const allLinks = this.linkRegistry.list();
      const link = allLinks.find((l) => l.name === linkName);
      if (!link) continue;

      // Determine FK column on the child record
      let fkColumn: string;
      if (link.from === childSchema) {
        fkColumn = `${link.to}_id`;
      } else {
        fkColumn = `${link.from}_id`;
      }

      const target: CascadeTarget = {
        parentSchema: info.schemaName,
        parentField: info.fieldName,
        derived: agg,
        link,
        fkColumn,
      };

      const existing = this.cascadeMap.get(childSchema) ?? [];
      existing.push(target);
      this.cascadeMap.set(childSchema, existing);
    }
  }

  /**
   * Extract dependency field names from a derived config.
   */
  private getDependencyFieldNames(derived: DerivedConfig): string[] {
    if (derived.deps) return derived.deps;

    switch (derived.type) {
      case "expression": {
        // Extract identifiers from expression
        const tokens = tokenize(derived.expr);
        return tokens.filter((t) => t.type === "identifier").map((t) => t.value);
      }
      case "concat":
        return derived.fields;
      case "function":
        return [];
      case "aggregate":
        return [];
      default:
        return [];
    }
  }

  /**
   * Build topological order per schema. Throws on cycles.
   */
  private buildTopoOrder(schemas: SchemaDefinition[]): void {
    for (const schema of schemas) {
      const schemaFields = new Map<string, Set<string>>();

      // Collect derived fields for this schema
      for (const [key, deps] of this.depGraph.entries()) {
        const info = this.fields.get(key);
        if (info?.schemaName === schema.name) {
          // Filter deps to only those within the same schema that are derived
          const localDeps = new Set<string>();
          for (const dep of deps) {
            if (this.fields.has(dep) && dep.startsWith(`${schema.name}.`)) {
              localDeps.add(dep);
            }
          }
          schemaFields.set(key, localDeps);
        }
      }

      if (schemaFields.size === 0) continue;

      // Kahn's algorithm for topological sort
      // Our graph: key depends on deps. So dep → key (dep must come before key).
      // In-degree of key = number of deps that are also derived fields in this schema.
      const inDegree = new Map<string, number>();
      for (const key of schemaFields.keys()) {
        inDegree.set(key, 0);
      }
      for (const [key, deps] of schemaFields.entries()) {
        for (const dep of deps) {
          if (schemaFields.has(dep)) {
            // key depends on dep → dep should come before key → key gets +1 in-degree
            inDegree.set(key, (inDegree.get(key) ?? 0) + 1);
          }
        }
      }

      const queue: string[] = [];
      for (const [key, deg] of inDegree.entries()) {
        if (deg === 0) queue.push(key);
      }

      const order: string[] = [];
      while (queue.length > 0) {
        // biome-ignore lint/style/noNonNullAssertion: queue is non-empty
        const current = queue.shift()!;
        order.push(current);

        // Find all nodes that depend on current
        for (const [key, deps] of schemaFields.entries()) {
          if (deps.has(current)) {
            const newDeg = (inDegree.get(key) ?? 0) - 1;
            inDegree.set(key, newDeg);
            if (newDeg === 0) queue.push(key);
          }
        }
      }

      if (order.length !== schemaFields.size) {
        const remaining = [...schemaFields.keys()].filter((k) => !order.includes(k));
        throw new Error(
          `[derived-property] Circular dependency detected in schema "${schema.name}": ${remaining.map((k) => k.split(".")[1]).join(" <-> ")}`,
        );
      }

      this.topoOrder.set(schema.name, order);
    }
  }

  /**
   * Get all derived fields for a schema.
   */
  getDerivedFields(schemaName: string): DerivedFieldInfo[] {
    const result: DerivedFieldInfo[] = [];
    for (const info of this.fields.values()) {
      if (info.schemaName === schemaName) {
        result.push(info);
      }
    }
    return result;
  }

  /**
   * Get derived fields that use the "compute" (read-time) strategy.
   */
  getComputeFields(schemaName: string): DerivedFieldInfo[] {
    return this.getDerivedFields(schemaName).filter((f) => f.strategy === "compute");
  }

  /**
   * Get derived fields that use the "store" (write-time) strategy.
   */
  getStoreFields(schemaName: string): DerivedFieldInfo[] {
    return this.getDerivedFields(schemaName).filter((f) => f.strategy === "store");
  }

  /**
   * Get aggregate derived fields for a schema.
   */
  getAggregateFields(schemaName: string): DerivedFieldInfo[] {
    return this.getDerivedFields(schemaName).filter((f) => f.derived.type === "aggregate");
  }

  /**
   * Get cascade targets for a child schema.
   * Returns the list of parent schema fields that need recalculation
   * when a record in the child schema is created, updated, or deleted.
   */
  getCascadeTargets(childSchemaName: string): CascadeTarget[] {
    return this.cascadeMap.get(childSchemaName) ?? [];
  }

  /**
   * Check if a child schema has any cascade targets (i.e., any parent schema
   * has aggregate derived fields that depend on this child schema).
   */
  hasCascadeTargets(childSchemaName: string): boolean {
    return (this.cascadeMap.get(childSchemaName) ?? []).length > 0;
  }

  /**
   * Resolve all "compute"-strategy derived fields for a record.
   * Modifies the record in-place and returns it.
   *
   * Call this when reading records (e.g., in GraphQL resolvers or data provider).
   * Note: aggregate compute-strategy fields require resolveComputeFieldsAsync().
   */
  resolveComputeFields(
    schemaName: string,
    record: Record<string, unknown>,
  ): Record<string, unknown> {
    const order = this.topoOrder.get(schemaName) ?? [];
    const resolvedFields = new Set<string>();

    // Resolve compute-strategy fields in topological order
    for (const key of order) {
      const info = this.fields.get(key);
      if (!info || info.strategy !== "compute") continue;

      const value = resolveDerivedValue(info.derived, record);
      if (value !== undefined) {
        record[info.fieldName] = value;
      }
      resolvedFields.add(info.fieldName);
    }

    // Also resolve any compute fields not in the topo order
    // (e.g., they have no inter-derived dependencies)
    for (const info of this.fields.values()) {
      if (info.schemaName !== schemaName || info.strategy !== "compute") continue;
      if (resolvedFields.has(info.fieldName)) continue; // Already resolved in topo order

      const value = resolveDerivedValue(info.derived, record);
      if (value !== undefined) {
        record[info.fieldName] = value;
      }
    }

    return record;
  }

  /**
   * Resolve all "compute"-strategy derived fields for a record, including async aggregates.
   * Modifies the record in-place and returns it.
   */
  async resolveComputeFieldsAsync(
    schemaName: string,
    record: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // First resolve all non-aggregate compute fields synchronously
    this.resolveComputeFields(schemaName, record);

    // Then resolve aggregate compute fields asynchronously
    if (this.dataProvider && this.linkRegistry) {
      for (const info of this.fields.values()) {
        if (
          info.schemaName !== schemaName ||
          info.strategy !== "compute" ||
          info.derived.type !== "aggregate"
        ) {
          continue;
        }
        const agg = info.derived;
        const allLinks = this.linkRegistry.list();
        const link = allLinks.find((l) => l.name === agg.source.link);
        if (!link) continue;

        const value = await resolveAggregateValue(agg, record, link, this.dataProvider);
        record[info.fieldName] = value;
      }
    }

    return record;
  }

  /**
   * Compute all "store"-strategy derived field values for a record (synchronous).
   * Returns a map of field name → computed value (to be merged into the write payload).
   *
   * Call this before writing a record (e.g., in Action Engine post-action).
   * Note: aggregate store-strategy fields require computeStoreFieldsAsync().
   */
  computeStoreFields(schemaName: string, record: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const order = this.topoOrder.get(schemaName) ?? [];

    // Use a working copy that includes computed values as we go
    const working = { ...record };

    // Resolve store-strategy fields in topological order
    for (const key of order) {
      const info = this.fields.get(key);
      if (!info || info.strategy !== "store") continue;

      // Skip aggregates in sync mode — they need async resolution
      if (info.derived.type === "aggregate") continue;

      const value = resolveDerivedValue(info.derived, working);
      if (value !== undefined) {
        result[info.fieldName] = value;
        working[info.fieldName] = value;
      }
    }

    // Also resolve any store fields not in the topo order
    for (const info of this.fields.values()) {
      if (info.schemaName !== schemaName || info.strategy !== "store") continue;
      if (result[info.fieldName] !== undefined) continue;
      if (info.derived.type === "aggregate") continue;

      const value = resolveDerivedValue(info.derived, working);
      if (value !== undefined) {
        result[info.fieldName] = value;
        working[info.fieldName] = value;
      }
    }

    return result;
  }

  /**
   * Compute all "store"-strategy derived field values for a record, including async aggregates.
   * Returns a map of field name → computed value (to be merged into the write payload).
   */
  async computeStoreFieldsAsync(
    schemaName: string,
    record: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    // Start with sync computations
    const result = this.computeStoreFields(schemaName, record);
    const working = { ...record, ...result };

    // Then resolve aggregate store fields asynchronously
    if (this.dataProvider && this.linkRegistry) {
      for (const info of this.fields.values()) {
        if (
          info.schemaName !== schemaName ||
          info.strategy !== "store" ||
          info.derived.type !== "aggregate"
        ) {
          continue;
        }
        const agg = info.derived;
        const allLinks = this.linkRegistry.list();
        const link = allLinks.find((l) => l.name === agg.source.link);
        if (!link) continue;

        const value = await resolveAggregateValue(agg, working, link, this.dataProvider);
        result[info.fieldName] = value;
        working[info.fieldName] = value;
      }
    }

    // Re-resolve any expression/function fields that depend on aggregate results
    const order = this.topoOrder.get(schemaName) ?? [];
    for (const key of order) {
      const info = this.fields.get(key);
      if (!info || info.strategy !== "store") continue;
      if (info.derived.type === "aggregate") continue;

      // Check if any dependency is an aggregate field
      const depNames = this.getDependencyFieldNames(info.derived);
      const hasAggDep = depNames.some(
        (d) =>
          result[d] !== undefined &&
          this.fields.get(`${schemaName}.${d}`)?.derived.type === "aggregate",
      );
      if (hasAggDep) {
        const value = resolveDerivedValue(info.derived, working);
        if (value !== undefined) {
          result[info.fieldName] = value;
          working[info.fieldName] = value;
        }
      }
    }

    return result;
  }

  /**
   * Cascade recalculate: when a child record is created, updated, or deleted,
   * find all affected parent records and recalculate their aggregate derived fields.
   * Recursively cascades up the chain if the parent schema itself has cascade targets,
   * up to `maxCascadeDepth` levels (default 5) to prevent infinite loops.
   *
   * @param childSchemaName - The schema of the record that changed
   * @param childRecord - The child record (for extracting FK values to find parent records)
   * @param dataProvider - Data provider for querying and updating parent records
   * @param options - Optional settings: maxCascadeDepth (default 5)
   * @returns Map of "parentSchema.parentId" → updated field values
   */
  async cascadeRecalculate(
    childSchemaName: string,
    childRecord: Record<string, unknown>,
    dataProvider?: DataProvider,
    options?: { maxCascadeDepth?: number },
  ): Promise<Map<string, Record<string, unknown>>> {
    const maxDepth = options?.maxCascadeDepth ?? 5;
    return this._cascadeRecalculateInternal(
      childSchemaName,
      childRecord,
      dataProvider,
      maxDepth,
      0,
    );
  }

  /**
   * Internal recursive cascade implementation with depth tracking.
   */
  private async _cascadeRecalculateInternal(
    childSchemaName: string,
    childRecord: Record<string, unknown>,
    dataProvider: DataProvider | undefined,
    maxDepth: number,
    currentDepth: number,
  ): Promise<Map<string, Record<string, unknown>>> {
    const dp = dataProvider ?? this.dataProvider;
    if (!dp) return new Map();

    if (currentDepth >= maxDepth) return new Map();

    const targets = this.getCascadeTargets(childSchemaName);
    if (targets.length === 0) return new Map();

    const updates = new Map<string, Record<string, unknown>>();

    for (const target of targets) {
      // Find the parent record ID from the child record's FK column
      const parentId = childRecord[target.fkColumn] as string | undefined;
      if (!parentId) continue;

      // Get the parent record
      let parentRecord: Record<string, unknown>;
      try {
        parentRecord = await dp.get(target.parentSchema, parentId);
      } catch {
        // Parent not found — skip (may have been deleted)
        continue;
      }

      // Recalculate the aggregate field
      const value = await resolveAggregateValue(target.derived, parentRecord, target.link, dp);

      // Collect update for this parent
      const updateKey = `${target.parentSchema}.${parentId}`;
      const existing = updates.get(updateKey) ?? {};
      existing[target.parentField] = value;
      updates.set(updateKey, existing);

      // Apply the update to the parent record
      await dp.update(target.parentSchema, parentId, { [target.parentField]: value });

      // Check if there are non-aggregate store fields that depend on this aggregate field
      const storeFields = this.getStoreFields(target.parentSchema);
      const updatedParent = { ...parentRecord, [target.parentField]: value };
      for (const sf of storeFields) {
        if (sf.derived.type === "aggregate") continue;
        const deps = this.getDependencyFieldNames(sf.derived);
        if (deps.includes(target.parentField)) {
          const recomputed = resolveDerivedValue(sf.derived, updatedParent);
          if (recomputed !== undefined) {
            existing[sf.fieldName] = recomputed;
            updatedParent[sf.fieldName] = recomputed;
            await dp.update(target.parentSchema, parentId, { [sf.fieldName]: recomputed });
          }
        }
      }

      // Recursively cascade: if the parent schema itself has cascade targets,
      // propagate the change upward
      if (this.hasCascadeTargets(target.parentSchema)) {
        const parentUpdates = await this._cascadeRecalculateInternal(
          target.parentSchema,
          updatedParent,
          dp,
          maxDepth,
          currentDepth + 1,
        );
        // Merge recursive updates into our result
        for (const [key, val] of parentUpdates) {
          const existingVal = updates.get(key);
          if (existingVal) {
            Object.assign(existingVal, val);
          } else {
            updates.set(key, val);
          }
        }
      }
    }

    return updates;
  }

  /**
   * Check if a field is derived.
   */
  isDerived(schemaName: string, fieldName: string): boolean {
    return this.fields.has(`${schemaName}.${fieldName}`);
  }

  /**
   * Get info for a specific derived field.
   */
  getFieldInfo(schemaName: string, fieldName: string): DerivedFieldInfo | undefined {
    return this.fields.get(`${schemaName}.${fieldName}`);
  }
}

// ── Factory ──────────────────────────────────────────────────

/** Create a new DerivedPropertyEngine instance */
export function createDerivedPropertyEngine(): DerivedPropertyEngine {
  return new DerivedPropertyEngine();
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Check if a field has a derived config (convenience type guard).
 */
export function isDerivedField(field: FieldDefinition): boolean {
  return field.derived != null;
}

/**
 * Get the strategy for a derived field (defaults to "store").
 */
export function getDerivedStrategy(field: FieldDefinition): "store" | "compute" {
  return (field.derived?.strategy as "store" | "compute") ?? "store";
}
