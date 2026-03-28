/**
 * Expression Parser (spec 48)
 *
 * Tokenizes and evaluates arithmetic/logic expressions against a record.
 * Uses a recursive descent parser — no eval() or Function constructor.
 *
 * Supported syntax:
 * - Numbers (including decimals): 42, 3.14
 * - Field references (identifiers): amount, total_price
 * - Operators: +, -, *, /, %, >, <, >=, <=, ==, !=, &&, ||, !
 * - Parentheses: (, )
 * - Ternary: ? :
 * - Boolean literals: true (→ 1), false (→ 0)
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

/**
 * Tokenize an expression string into numbers, operators, parentheses, and field references.
 */
export function tokenize(expr: string): Token[] {
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
