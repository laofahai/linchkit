/**
 * AI Context Masker
 *
 * Reversible masking for sensitive data before sending to AI models.
 * Unlike PII sanitization (which is one-way redaction), context masking
 * replaces sensitive values with opaque tokens that can be reversed
 * after receiving the AI response.
 *
 * Use cases:
 * - Send entity records to AI for analysis without exposing real PII
 * - De-mask AI responses that reference the masked tokens
 * - Field-level masking rules based on entity definitions
 */

// ── Types ───────────────────────────────────────────────────

/** A single masking rule that matches content by pattern */
export interface ContextMaskingRule {
  /** Rule name for logging */
  name: string;

  /** Regex pattern to match sensitive content */
  pattern: RegExp;

  /** Category label used in the mask token (e.g. "EMAIL", "PHONE") */
  category: string;
}

/** Configuration for the context masker */
export interface ContextMaskerConfig {
  /** Additional custom masking rules (merged with built-in rules) */
  customRules?: ContextMaskingRule[];

  /** Whether to use built-in rules (default: true) */
  useBuiltinRules?: boolean;

  /** Prefix for mask tokens (default: "MASKED") */
  tokenPrefix?: string;

  /** Specific field names to always mask (regardless of pattern matching) */
  alwaysMaskFields?: string[];
}

/** Result of masking an object or string */
export interface MaskingResult<T = string> {
  /** The masked output */
  masked: T;

  /** Number of values that were masked */
  maskCount: number;

  /** The masking session that can unmask responses */
  session: MaskingSession;
}

/** Opaque session holding the mask-to-value mapping for de-masking */
export class MaskingSession {
  /** Map from mask token -> original value */
  private readonly tokenMap: Map<string, string> = new Map();
  private counter = 0;
  private readonly prefix: string;

  constructor(prefix = "MASKED") {
    this.prefix = prefix;
  }

  /** Register a value and return its mask token */
  mask(value: string, category: string): string {
    // Check if this exact value was already masked (dedup)
    for (const [token, existing] of this.tokenMap) {
      if (existing === value) {
        return token;
      }
    }

    this.counter++;
    const token = `[${this.prefix}_${category}_${this.counter}]`;
    this.tokenMap.set(token, value);
    return token;
  }

  /** Replace all mask tokens in a string with their original values */
  unmask(text: string): string {
    let result = text;
    for (const [token, original] of this.tokenMap) {
      // Use split+join for literal string replacement (no regex escaping needed)
      result = result.split(token).join(original);
    }
    return result;
  }

  /** Get the number of masked values in this session */
  get size(): number {
    return this.tokenMap.size;
  }

  /** Get all tokens in this session (for debugging/logging) */
  get tokens(): string[] {
    return [...this.tokenMap.keys()];
  }
}

// ── Built-in Rules ──────────────────────────────────────────

const BUILTIN_RULES: ContextMaskingRule[] = [
  {
    name: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    category: "EMAIL",
  },
  {
    name: "phone_international",
    // Matches: +1-234-567-8901, (234) 567-8901, 13800138000
    pattern: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{4}\b/g,
    category: "PHONE",
  },
  {
    name: "ssn",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    category: "SSN",
  },
  {
    name: "credit_card",
    pattern: /\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,7}\b/g,
    category: "CC",
  },
  {
    name: "chinese_id",
    pattern: /\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g,
    category: "ID",
  },
  {
    name: "ip_address",
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    category: "IP",
  },
];

// ── Public API ──────────────────────────────────────────────

/**
 * Mask sensitive patterns in a string. Returns a MaskingResult with
 * the masked string and a session that can reverse the masking.
 */
export function maskContext(text: string, config?: ContextMaskerConfig): MaskingResult<string> {
  const session = new MaskingSession(config?.tokenPrefix ?? "MASKED");
  const rules = resolveRules(config);

  let masked = text;
  let maskCount = 0;

  for (const rule of rules) {
    const regex = new RegExp(
      rule.pattern.source,
      `${rule.pattern.flags}${rule.pattern.flags.includes("g") ? "" : "g"}`,
    );
    masked = masked.replace(regex, (match) => {
      maskCount++;
      return session.mask(match, rule.category);
    });
  }

  return { masked, maskCount, session };
}

/**
 * Mask sensitive fields in a record (key-value object).
 *
 * Applies pattern-based masking to string values, and optionally
 * masks entire fields listed in `alwaysMaskFields`.
 */
export function maskRecord(
  record: Record<string, unknown>,
  config?: ContextMaskerConfig,
): MaskingResult<Record<string, unknown>> {
  const session = new MaskingSession(config?.tokenPrefix ?? "MASKED");
  const rules = resolveRules(config);
  const alwaysMask = new Set(config?.alwaysMaskFields ?? []);

  const masked: Record<string, unknown> = {};
  let maskCount = 0;

  for (const [key, value] of Object.entries(record)) {
    // Always-mask fields: mask the entire value as one token
    if (alwaysMask.has(key)) {
      if (typeof value === "string" && value.length > 0) {
        const token = session.mask(value, "FIELD");
        masked[key] = token;
        maskCount++;
      } else if (value !== null && value !== undefined) {
        const strValue = JSON.stringify(value);
        const token = session.mask(strValue, "FIELD");
        masked[key] = token;
        maskCount++;
      } else {
        masked[key] = value;
      }
      continue;
    }

    // Pattern-based masking for string values
    if (typeof value === "string") {
      let fieldMasked = value;
      for (const rule of rules) {
        const regex = new RegExp(
          rule.pattern.source,
          `${rule.pattern.flags}${rule.pattern.flags.includes("g") ? "" : "g"}`,
        );
        fieldMasked = fieldMasked.replace(regex, (match) => {
          maskCount++;
          return session.mask(match, rule.category);
        });
      }
      masked[key] = fieldMasked;
    } else {
      masked[key] = value;
    }
  }

  return { masked, maskCount, session };
}

/**
 * Unmask all tokens in a string using a previous masking session.
 * Convenience wrapper around `session.unmask()`.
 */
export function unmaskContext(text: string, session: MaskingSession): string {
  return session.unmask(text);
}

// ── Private ─────────────────────────────────────────────────

function resolveRules(config?: ContextMaskerConfig): ContextMaskingRule[] {
  const useBuiltin = config?.useBuiltinRules ?? true;
  return [...(useBuiltin ? BUILTIN_RULES : []), ...(config?.customRules ?? [])];
}
