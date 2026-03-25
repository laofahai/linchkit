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
 * - aggregate: cross-record aggregation (stub — requires Link integration, M4)
 *
 * Strategies:
 * - store: persisted to DB, recalculated on write (default)
 * - compute: calculated on read, not persisted
 */

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

/** Aggregate derivation (stub — full implementation in M4) */
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
    if (
      /[0-9]/.test(ch) ||
      (ch === "." && i + 1 < len && /[0-9]/.test(expr.charAt(i + 1)))
    ) {
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
    while (current && current.type === "operator" && (current.value === "+" || current.value === "-")) {
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
        if (right === 0) throw new Error("[derived-property] Division by zero");
        left /= right;
      } else {
        if (right === 0) throw new Error("[derived-property] Modulo by zero");
        left %= right;
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
 * Resolve a single derived field value for a record.
 *
 * @param derived - The derived configuration from the field definition
 * @param record - The current record data
 * @returns The computed value, or undefined if cannot compute (e.g. aggregate stub)
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
      // Aggregate requires data provider access — stub returns undefined
      // Full implementation in M4 when Link-based cross-record queries are available
      return undefined;

    default:
      return undefined;
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
 */
export class DerivedPropertyEngine {
  /** All registered derived fields, keyed by "schema.field" */
  private fields = new Map<string, DerivedFieldInfo>();

  /** Dependency graph: "schema.field" → set of "schema.field" it depends on */
  private depGraph = new Map<string, Set<string>>();

  /** Topological order for store-strategy fields (schema-scoped) */
  private topoOrder = new Map<string, string[]>();

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

        // Build dependency edges (within same schema only for now)
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
   * Resolve all "compute"-strategy derived fields for a record.
   * Modifies the record in-place and returns it.
   *
   * Call this when reading records (e.g., in GraphQL resolvers or data provider).
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
   * Compute all "store"-strategy derived field values for a record.
   * Returns a map of field name → computed value (to be merged into the write payload).
   *
   * Call this before writing a record (e.g., in Action Engine post-action).
   */
  computeStoreFields(
    schemaName: string,
    record: Record<string, unknown>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const order = this.topoOrder.get(schemaName) ?? [];

    // Use a working copy that includes computed values as we go
    const working = { ...record };

    // Resolve store-strategy fields in topological order
    for (const key of order) {
      const info = this.fields.get(key);
      if (!info || info.strategy !== "store") continue;

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

      const value = resolveDerivedValue(info.derived, working);
      if (value !== undefined) {
        result[info.fieldName] = value;
        working[info.fieldName] = value;
      }
    }

    return result;
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
