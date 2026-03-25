/**
 * Prompt Sanitizer
 *
 * Input sanitization for AI prompts — detects prompt injection attempts and
 * redacts PII before sending data to external AI services.
 *
 * See spec 27_ai_security.md §1.1 (Prompt Injection) and §1.4 (Data Leakage).
 *
 * Two main capabilities:
 * 1. Prompt injection detection — pattern-based + score-based risk assessment
 * 2. PII sanitization — detect and redact common PII patterns
 */

import { resolveFieldMasking } from "../security/masking-engine";
import type { FieldDefinition, SchemaDefinition } from "../types/schema";

// ── Prompt Injection Detection ──────────────────────────────

/** Result of prompt injection detection scan */
export interface InjectionDetectionResult {
  /** Whether any injection patterns were detected */
  detected: boolean;

  /** Risk score from 0 (safe) to 1 (definitely injection) */
  score: number;

  /** Names of patterns that matched */
  matchedPatterns: string[];

  /** Recommended action based on configured thresholds */
  action: "allow" | "warn" | "block";

  /** Original input (unmodified) */
  input: string;
}

/** A single injection detection pattern */
export interface InjectionPattern {
  /** Pattern name for logging */
  name: string;

  /** Regex pattern to match against input */
  pattern: RegExp;

  /** Weight for score calculation (0-1, default: 0.3) */
  weight?: number;
}

/** Configuration for prompt injection detection */
export interface InjectionDetectionConfig {
  /** Additional custom patterns (merged with built-in patterns) */
  customPatterns?: InjectionPattern[];

  /** Score threshold to trigger a warning (default: 0.3) */
  warnThreshold?: number;

  /** Score threshold to trigger blocking (default: 0.7) */
  blockThreshold?: number;

  /** Action on detection: block, warn, or log (default: "warn") */
  defaultAction?: "block" | "warn" | "log";

  /** Whether to use built-in patterns (default: true) */
  useBuiltinPatterns?: boolean;
}

// ── Built-in Injection Patterns ─────────────────────────────

const BUILTIN_INJECTION_PATTERNS: InjectionPattern[] = [
  {
    name: "ignore_instructions",
    pattern:
      /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?|directives?)/i,
    weight: 0.8,
  },
  {
    name: "new_instructions",
    pattern: /new\s+(instructions?|rules?|directives?)\s*:/i,
    weight: 0.6,
  },
  {
    name: "system_prompt_override",
    pattern: /system\s*prompt\s*[:=]|you\s+are\s+now\s+a/i,
    weight: 0.9,
  },
  {
    name: "role_override",
    pattern: /act\s+as\s+(a\s+)?(different|new|another)\s+(role|assistant|agent|system)/i,
    weight: 0.7,
  },
  {
    name: "prompt_leak_attempt",
    pattern:
      /reveal\s+(your|the|system)\s+(prompt|instructions?|rules?)|show\s+me\s+(your|the)\s+prompt/i,
    weight: 0.6,
  },
  {
    name: "delimiter_injection",
    pattern: /```\s*(system|assistant|user)\s*\n|<\|?(system|im_start|endoftext)\|?>/i,
    weight: 0.9,
  },
  {
    name: "override_command",
    pattern: /override\s+(all\s+)?(safety|security|restrictions?|rules?|filters?|constraints?)/i,
    weight: 0.8,
  },
  {
    name: "jailbreak_keywords",
    pattern: /\b(jailbreak|DAN|do\s+anything\s+now)\b/i,
    weight: 0.9,
  },
  {
    name: "instruction_boundary",
    pattern: /---+\s*(BEGIN|END|START)\s+(SYSTEM|INSTRUCTIONS?|PROMPT)/i,
    weight: 0.7,
  },
  {
    name: "encoding_evasion",
    pattern: /base64\s*[:=]|eval\s*\(|\\x[0-9a-f]{2}/i,
    weight: 0.5,
  },
  {
    name: "output_manipulation",
    pattern: /respond\s+only\s+with|output\s+exactly|print\s+the\s+following|say\s+"[^"]+"/i,
    weight: 0.4,
  },
  {
    name: "chinese_ignore_instructions",
    pattern: /忽略(之前|以上|所有)(的)?(指令|指示|规则|提示|限制)/,
    weight: 0.8,
  },
  {
    name: "chinese_role_override",
    pattern: /你现在是|扮演(一个|一位)?(新的|不同的)/,
    weight: 0.6,
  },
];

/**
 * Detect prompt injection attempts in user input.
 *
 * Uses pattern-based detection with weighted scoring. Each matched pattern
 * contributes to a cumulative risk score (capped at 1.0). The score is
 * compared against configurable thresholds to determine the action.
 */
export function detectInjection(
  input: string,
  config?: InjectionDetectionConfig,
): InjectionDetectionResult {
  const useBuiltin = config?.useBuiltinPatterns ?? true;
  const patterns = [
    ...(useBuiltin ? BUILTIN_INJECTION_PATTERNS : []),
    ...(config?.customPatterns ?? []),
  ];
  const warnThreshold = config?.warnThreshold ?? 0.3;
  const blockThreshold = config?.blockThreshold ?? 0.7;

  const matchedPatterns: string[] = [];
  let totalScore = 0;

  for (const p of patterns) {
    if (p.pattern.test(input)) {
      matchedPatterns.push(p.name);
      totalScore += p.weight ?? 0.3;
    }
  }

  // Cap score at 1.0
  const score = Math.min(totalScore, 1.0);
  const detected = matchedPatterns.length > 0;

  let action: InjectionDetectionResult["action"];
  if (score >= blockThreshold) {
    action = "block";
  } else if (score >= warnThreshold) {
    action = "warn";
  } else {
    action = "allow";
  }

  return {
    detected,
    score,
    matchedPatterns,
    action,
    input,
  };
}

// ── PII Sanitization ────────────────────────────────────────

/** Types of PII that can be detected and redacted */
export type PIIType = "email" | "phone" | "ssn" | "credit_card" | "ip_address" | "id_number";

/** Result of PII sanitization */
export interface PIISanitizationResult {
  /** Sanitized text with PII replaced by placeholders */
  sanitized: string;

  /** Original text (unmodified) */
  original: string;

  /** PII types that were found and redacted */
  piiTypesFound: PIIType[];

  /** Number of PII instances redacted */
  redactionCount: number;

  /** Field names that had PII redacted (if field-level sanitization was used) */
  redactedFields?: string[];
}

/** A single PII detection pattern */
export interface PIIPattern {
  /** PII type name */
  type: PIIType;

  /** Regex pattern to detect this PII type */
  pattern: RegExp;

  /** Replacement placeholder (default: "[REDACTED_{TYPE}]") */
  placeholder?: string;
}

/** Configuration for PII sanitization */
export interface PIISanitizationConfig {
  /** Additional custom PII patterns (merged with built-in patterns) */
  customPatterns?: PIIPattern[];

  /** PII types to detect (default: all built-in types) */
  enabledTypes?: PIIType[];

  /** Whether to use built-in PII patterns (default: true) */
  useBuiltinPatterns?: boolean;

  /** Custom placeholder format function */
  placeholderFn?: (type: PIIType) => string;
}

// ── Built-in PII Patterns ───────────────────────────────────

// Order matters: more specific patterns must come before less specific ones.
// ID number (18 digits structured) before credit card (13-19 digits loose).
// Credit card before phone (overlapping digit sequences).
const BUILTIN_PII_PATTERNS: PIIPattern[] = [
  {
    type: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    placeholder: "[REDACTED_EMAIL]",
  },
  {
    type: "ssn",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    placeholder: "[REDACTED_SSN]",
  },
  {
    type: "id_number",
    // Chinese national ID (18 digits, last may be X) — must precede credit card and phone
    pattern: /\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g,
    placeholder: "[REDACTED_ID]",
  },
  {
    type: "credit_card",
    // Credit card numbers with separators (13-19 digits with spaces or dashes)
    pattern: /\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,7}\b/g,
    placeholder: "[REDACTED_CREDIT_CARD]",
  },
  {
    type: "phone",
    // International and common formats: +1-234-567-8901, (234) 567-8901, 13800138000
    pattern: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{4}\b/g,
    placeholder: "[REDACTED_PHONE]",
  },
  {
    type: "ip_address",
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    placeholder: "[REDACTED_IP]",
  },
];

/**
 * Sanitize PII from text before sending to external AI services.
 *
 * Detects common PII patterns (email, phone, SSN, credit card, etc.)
 * and replaces them with safe placeholders.
 */
export function sanitizePII(text: string, config?: PIISanitizationConfig): PIISanitizationResult {
  const useBuiltin = config?.useBuiltinPatterns ?? true;
  const allPatterns = [
    ...(useBuiltin ? BUILTIN_PII_PATTERNS : []),
    ...(config?.customPatterns ?? []),
  ];

  const enabledTypes = config?.enabledTypes;
  const patterns = enabledTypes
    ? allPatterns.filter((p) => enabledTypes.includes(p.type))
    : allPatterns;

  const placeholderFn =
    config?.placeholderFn ?? ((type: PIIType) => `[REDACTED_${type.toUpperCase()}]`);

  let sanitized = text;
  const piiTypesFound = new Set<PIIType>();
  let redactionCount = 0;

  for (const p of patterns) {
    // Reset regex lastIndex for global patterns
    const regex = new RegExp(p.pattern.source, p.pattern.flags);
    const matches = sanitized.match(regex);
    if (matches) {
      piiTypesFound.add(p.type);
      redactionCount += matches.length;
      // Custom placeholderFn takes priority over pattern-level placeholder
      const placeholder = config?.placeholderFn
        ? placeholderFn(p.type)
        : (p.placeholder ?? placeholderFn(p.type));
      sanitized = sanitized.replace(regex, placeholder);
    }
  }

  return {
    sanitized,
    original: text,
    piiTypesFound: [...piiTypesFound],
    redactionCount,
  };
}

// ── Schema-aware PII Sanitization ───────────────────────────

/**
 * Sanitize a data record based on schema field definitions before sending to AI.
 *
 * Uses field-level `sensitive` and `secret` markers from SchemaDefinition
 * (integrating with the existing masking engine) to determine which fields
 * need PII sanitization. Secret fields are completely removed. Sensitive
 * fields are PII-scanned and redacted.
 *
 * Returns a sanitized copy — does not mutate the input.
 */
export function sanitizeRecordForAI(
  record: Record<string, unknown>,
  schema: SchemaDefinition,
  config?: PIISanitizationConfig & {
    /** Additional field names to always redact (beyond schema markers) */
    alwaysRedactFields?: string[];
  },
): { sanitized: Record<string, unknown>; redactedFields: string[]; piiTypesFound: PIIType[] } {
  const result = { ...record };
  const redactedFields: string[] = [];
  const piiTypesFound = new Set<PIIType>();
  const alwaysRedact = new Set(config?.alwaysRedactFields ?? []);

  for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
    if (!(fieldName in result)) continue;

    const masking = resolveFieldMasking(fieldDef as FieldDefinition);

    // Secret fields: remove entirely from AI context
    if (fieldDef.secret) {
      delete result[fieldName];
      redactedFields.push(fieldName);
      continue;
    }

    // Sensitive fields or always-redact fields: apply PII sanitization
    if (fieldDef.sensitive || masking || alwaysRedact.has(fieldName)) {
      const value = result[fieldName];
      if (typeof value === "string") {
        const piiResult = sanitizePII(value, config);
        if (piiResult.redactionCount > 0) {
          result[fieldName] = piiResult.sanitized;
          redactedFields.push(fieldName);
          for (const t of piiResult.piiTypesFound) {
            piiTypesFound.add(t);
          }
        }
      } else if (value !== null && value !== undefined) {
        // For non-string sensitive values, redact entirely
        result[fieldName] = "[REDACTED]";
        redactedFields.push(fieldName);
      }
    }
  }

  return {
    sanitized: result,
    redactedFields,
    piiTypesFound: [...piiTypesFound],
  };
}

// ── Combined Sanitization ───────────────────────────────────

/** Options for the full prompt sanitization pipeline */
export interface PromptSanitizerOptions {
  /** Injection detection config */
  injection?: InjectionDetectionConfig;

  /** PII sanitization config */
  pii?: PIISanitizationConfig;

  /** Whether to run PII sanitization (default: true) */
  enablePII?: boolean;

  /** Whether to run injection detection (default: true) */
  enableInjectionDetection?: boolean;
}

/** Combined result of full sanitization pipeline */
export interface SanitizationResult {
  /** Final sanitized text */
  sanitized: string;

  /** Injection detection result */
  injection: InjectionDetectionResult;

  /** PII sanitization result (if enabled) */
  pii?: PIISanitizationResult;

  /** Whether the prompt was blocked */
  blocked: boolean;

  /** Reason for blocking (if blocked) */
  blockReason?: string;
}

/**
 * Run the full sanitization pipeline: injection detection + PII redaction.
 *
 * Steps:
 * 1. Detect prompt injection attempts
 * 2. If injection is detected and action is "block", return blocked result
 * 3. Sanitize PII from the prompt text
 * 4. Return sanitized text ready for AI consumption
 */
export function sanitizePrompt(text: string, options?: PromptSanitizerOptions): SanitizationResult {
  const enableInjection = options?.enableInjectionDetection ?? true;
  const enablePII = options?.enablePII ?? true;

  // Step 1: Injection detection
  const injection = enableInjection
    ? detectInjection(text, options?.injection)
    : { detected: false, score: 0, matchedPatterns: [], action: "allow" as const, input: text };

  // Step 2: Block if injection detected — return empty string to prevent passthrough
  if (injection.action === "block") {
    return {
      sanitized: "",
      injection,
      blocked: true,
      blockReason: `Prompt injection detected (score: ${injection.score.toFixed(2)}, patterns: ${injection.matchedPatterns.join(", ")})`,
    };
  }

  // Step 3: PII sanitization
  let pii: PIISanitizationResult | undefined;
  let sanitized = text;

  if (enablePII) {
    pii = sanitizePII(text, options?.pii);
    sanitized = pii.sanitized;
  }

  return {
    sanitized,
    injection,
    pii,
    blocked: false,
  };
}
