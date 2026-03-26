/**
 * AI Output Validator
 *
 * Validates AI-generated content for safety before it reaches the application.
 * Detects dangerous patterns such as:
 * - Code injection (JavaScript, SQL, shell commands)
 * - Cross-site scripting (XSS) payloads
 * - Prompt leakage (system prompt fragments in output)
 * - Forbidden structural patterns (e.g., AI trying to output action override instructions)
 *
 * See spec 27_ai_security.md §1.2, §2.3 — output validation as a last-resort safety net.
 */

// ── Types ─────────────────────────────────────────────────────

/** Categories of output safety violations */
export type OutputViolationType =
  | "code_injection"
  | "sql_injection"
  | "xss_payload"
  | "shell_injection"
  | "prompt_leakage"
  | "forbidden_instruction"
  | "data_exfiltration"
  | "custom";

/** Severity of detected violation */
export type OutputViolationSeverity = "low" | "medium" | "high" | "critical";

/** A single output validation finding */
export interface OutputViolation {
  /** Type of violation */
  type: OutputViolationType;

  /** Severity level */
  severity: OutputViolationSeverity;

  /** Human-readable description */
  description: string;

  /** Pattern name that matched */
  patternName: string;

  /** Matched content snippet (truncated for safety) */
  matchedSnippet?: string;
}

/** Result of output validation */
export interface OutputValidationResult {
  /** Whether the output is considered safe */
  safe: boolean;

  /** List of detected violations (empty if safe) */
  violations: OutputViolation[];

  /** Recommended action based on worst violation */
  action: "pass" | "sanitize" | "block";

  /** Sanitized output (if sanitization was applied) */
  sanitizedOutput?: string;
}

/** A custom output validation rule */
export interface OutputValidationRule {
  /** Rule name for identification */
  name: string;

  /** Violation type to report when matched */
  type: OutputViolationType;

  /** Severity to assign */
  severity: OutputViolationSeverity;

  /** Regex pattern to match against output */
  pattern: RegExp;

  /** Human-readable description */
  description: string;

  /** Action when matched: block stops processing, sanitize removes the match */
  action: "block" | "sanitize" | "warn";
}

/** Configuration for the output validator */
export interface OutputValidatorConfig {
  /** Whether to use built-in rules (default: true) */
  useBuiltinRules?: boolean;

  /** Additional custom rules */
  customRules?: OutputValidationRule[];

  /** Whether to apply sanitization for sanitize-action rules (default: true) */
  applySanitization?: boolean;

  /** Maximum output length to accept (characters, default: 100_000) */
  maxOutputLength?: number;

  /** Patterns that are known-safe (whitelisted) — skips matching against these */
  allowPatterns?: RegExp[];
}

// ── Built-in Validation Rules ───────────────────────────────────

const BUILTIN_RULES: OutputValidationRule[] = [
  // Code injection patterns
  {
    name: "js_eval",
    type: "code_injection",
    severity: "critical",
    pattern: /\beval\s*\(|new\s+Function\s*\(|setTimeout\s*\(\s*["'`]/i,
    description: "JavaScript eval/Function constructor detected in AI output",
    action: "block",
  },
  {
    name: "js_script_tag",
    type: "xss_payload",
    severity: "critical",
    pattern: /<script[\s>]|<\/script>|javascript\s*:/i,
    description: "Script tag or javascript: protocol in AI output",
    action: "block",
  },
  {
    name: "xss_event_handler",
    type: "xss_payload",
    severity: "high",
    pattern: /\bon(?:error|load|click|mouseover|focus|blur|submit|change)\s*=\s*["'`]/i,
    description: "HTML event handler attribute in AI output",
    action: "sanitize",
  },
  {
    name: "xss_data_uri",
    type: "xss_payload",
    severity: "high",
    pattern: /data\s*:\s*text\/html/i,
    description: "Data URI with text/html content type in AI output",
    action: "block",
  },

  // SQL injection patterns
  {
    name: "sql_drop",
    type: "sql_injection",
    severity: "critical",
    pattern: /\bDROP\s+(?:TABLE|DATABASE|INDEX|VIEW|SCHEMA)\b/i,
    description: "SQL DROP statement in AI output",
    action: "block",
  },
  {
    name: "sql_union_select",
    type: "sql_injection",
    severity: "high",
    pattern: /\bUNION\s+(?:ALL\s+)?SELECT\b/i,
    description: "SQL UNION SELECT injection pattern in AI output",
    action: "block",
  },
  {
    name: "sql_delete_truncate",
    type: "sql_injection",
    severity: "critical",
    pattern: /\b(?:DELETE\s+FROM|TRUNCATE\s+TABLE)\s+\w+(?:\s*;|\s*$)/i,
    description: "SQL DELETE FROM or TRUNCATE TABLE in AI output",
    action: "block",
  },
  {
    name: "sql_alter_table",
    type: "sql_injection",
    severity: "high",
    pattern: /\bALTER\s+TABLE\s+\w+\s+(?:DROP|ADD|MODIFY)\b/i,
    description: "SQL ALTER TABLE modification in AI output",
    action: "block",
  },

  // Shell injection
  {
    name: "shell_command",
    type: "shell_injection",
    severity: "critical",
    pattern: /\b(?:rm\s+-rf\s+\/|sudo\s+|chmod\s+777|curl\s+.*\|\s*(?:ba)?sh)\b/i,
    description: "Dangerous shell command in AI output",
    action: "block",
  },
  {
    name: "shell_backtick_exec",
    type: "shell_injection",
    severity: "high",
    pattern: /`[^`]*(?:rm|cat|wget|curl|nc|ncat|bash|sh|python|perl|ruby)\s+[^`]*`/i,
    description: "Shell command execution via backticks in AI output",
    action: "block",
  },

  // Prompt leakage patterns
  {
    name: "system_prompt_leak",
    type: "prompt_leakage",
    severity: "high",
    pattern: /(?:system\s+prompt|internal\s+instructions?|my\s+instructions?\s+(?:are|say))\s*:/i,
    description: "Potential system prompt leakage in AI output",
    action: "sanitize",
  },

  // Forbidden instructions (AI trying to override rules)
  {
    name: "rule_override_instruction",
    type: "forbidden_instruction",
    severity: "critical",
    pattern: /(?:disable|remove|bypass|skip|ignore)\s+(?:all\s+)?(?:rules?|validations?|permissions?|security|checks?)/i,
    description: "AI output contains instruction to bypass security controls",
    action: "block",
  },
  {
    name: "admin_escalation",
    type: "forbidden_instruction",
    severity: "critical",
    pattern: /(?:grant|set|assign)\s+(?:admin|superuser|root|system_admin)\s+(?:role|permission|access|privilege)/i,
    description: "AI output contains privilege escalation instruction",
    action: "block",
  },

  // Data exfiltration patterns
  {
    name: "base64_large_blob",
    type: "data_exfiltration",
    severity: "medium",
    pattern: /(?:[A-Za-z0-9+/]{100,}={0,2})/,
    description: "Large base64-encoded blob in AI output (potential data exfiltration)",
    action: "warn",
  },
  {
    name: "url_with_data_param",
    type: "data_exfiltration",
    severity: "high",
    pattern: /https?:\/\/[^\s]+\?[^\s]*(?:data|payload|content|body|dump)=[^\s]{50,}/i,
    description: "URL with large data parameter in AI output",
    action: "block",
  },
];

// ── Output Validator ─────────────────────────────────────────────

/**
 * Validate AI-generated output for safety.
 *
 * Runs the output through a set of security rules and returns a result
 * indicating whether the output is safe to use. Optionally sanitizes
 * the output by removing matched patterns.
 */
export function validateAIOutput(
  output: string,
  config?: OutputValidatorConfig,
): OutputValidationResult {
  const useBuiltin = config?.useBuiltinRules ?? true;
  const rules = [
    ...(useBuiltin ? BUILTIN_RULES : []),
    ...(config?.customRules ?? []),
  ];
  const applySanitization = config?.applySanitization ?? true;
  const maxLength = config?.maxOutputLength ?? 100_000;
  const allowPatterns = config?.allowPatterns ?? [];

  const violations: OutputViolation[] = [];
  let shouldBlock = false;
  let sanitizedOutput = output;

  // Check output length
  if (output.length > maxLength) {
    violations.push({
      type: "data_exfiltration",
      severity: "high",
      description: `Output exceeds maximum length: ${output.length} > ${maxLength}`,
      patternName: "max_output_length",
    });
    shouldBlock = true;
  }

  // Check each rule
  for (const rule of rules) {
    // Skip if the content matches an allow pattern
    if (allowPatterns.some((ap) => ap.test(output))) {
      continue;
    }

    // Create a fresh regex to avoid lastIndex state issues with global regexes
    const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
    const match = regex.exec(output);

    if (match) {
      const snippet = match[0].length > 100 ? `${match[0].slice(0, 100)}...` : match[0];

      violations.push({
        type: rule.type,
        severity: rule.severity,
        description: rule.description,
        patternName: rule.name,
        matchedSnippet: snippet,
      });

      if (rule.action === "block") {
        shouldBlock = true;
      } else if (rule.action === "sanitize" && applySanitization) {
        // Replace matched content with a safe placeholder
        const sanitizeRegex = new RegExp(rule.pattern.source, `${rule.pattern.flags}g`);
        sanitizedOutput = sanitizedOutput.replace(sanitizeRegex, "[SANITIZED]");
      }
    }
  }

  // Determine final action
  let action: OutputValidationResult["action"];
  if (shouldBlock) {
    action = "block";
  } else if (violations.some((v) => v.severity === "high" || v.severity === "medium")) {
    action = "sanitize";
  } else {
    action = "pass";
  }

  const safe = violations.length === 0;

  return {
    safe,
    violations,
    action,
    sanitizedOutput: !safe && applySanitization ? sanitizedOutput : undefined,
  };
}

/**
 * Sanitize AI output by removing all dangerous patterns.
 *
 * Unlike validateAIOutput (which reports findings), this function
 * aggressively removes all matched patterns and returns clean text.
 * Use when you need to use the output despite detected issues.
 */
export function sanitizeAIOutput(
  output: string,
  config?: Omit<OutputValidatorConfig, "applySanitization">,
): string {
  const result = validateAIOutput(output, { ...config, applySanitization: true });
  return result.sanitizedOutput ?? output;
}
