/**
 * ProposalCodeGenerator — generates implementation code from approved proposals.
 *
 * Uses a CodeGenerationProvider (AI model) to produce TypeScript code for
 * LinchKit defineXxx() definitions. Validates via quality gates and retries on failure.
 */

import type { Proposal, ProposalType } from "./proposal-engine";

/** AI code generation provider — implemented by cap-ai-provider */
export interface CodeGenerationProvider {
  generateCode(prompt: string, context?: string): Promise<string>;
}

export interface CodeGenerationResult {
  success: boolean;
  files: Record<string, string>;
  errors?: string[];
  attempts: number;
}

export interface QualityGateRunner {
  check(files: Record<string, string>): Promise<string[]>;
}

export interface ProjectContext {
  entities: Array<{ name: string; fields: string[] }>;
  actions: Array<{ name: string; entity: string }>;
  conventions?: string;
}

// ── Type-specific prompt guidance ────────────────────────────

const typeGuidance: Record<ProposalType, string> = {
  add_rule: [
    "Generate a RuleDefinition using defineRule().",
    "Include: name, label, description, priority, trigger (action), condition, effect.",
    "Effect types: block, enrich, validate.",
  ].join("\n"),
  update_rule: [
    "Update an EXISTING RuleDefinition (defineRule()) in place.",
    "Keep the rule's name unchanged; modify only what the proposal diff describes.",
    "Emit the FULL updated definition: name, label, description, priority, trigger, condition, effect.",
  ].join("\n"),
  add_automation: [
    "Generate an EventHandlerDefinition for reactive event handling.",
    "Include: name, description, listen (event type), handler function.",
  ].join("\n"),
  modify_schema: [
    "Generate or modify an EntityDefinition using defineEntity().",
    "Include: name, label, fields with type/required/label.",
    "Preserve existing fields when modifying.",
  ].join("\n"),
  add_default: [
    "Modify an EntityDefinition to add default values to fields.",
    "Use the `default` property on the relevant field definition.",
  ].join("\n"),
};

// ── ProposalCodeGenerator ────────────────────────────────────

export class ProposalCodeGenerator {
  private readonly provider: CodeGenerationProvider;
  private readonly qualityGates?: QualityGateRunner;
  private readonly maxRetries: number;

  constructor(provider: CodeGenerationProvider, qualityGates?: QualityGateRunner, maxRetries = 3) {
    this.provider = provider;
    this.qualityGates = qualityGates;
    this.maxRetries = maxRetries;
  }

  /**
   * Generate implementation code from an approved proposal.
   * Retries on quality gate failures up to maxRetries.
   */
  async generate(proposal: Proposal, context?: ProjectContext): Promise<CodeGenerationResult> {
    let lastErrors: string[] = [];

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      const prompt =
        lastErrors.length > 0
          ? this.buildRetryPrompt(proposal, context, lastErrors)
          : this.buildPrompt(proposal, context);

      const raw = await this.provider.generateCode(prompt);
      const files = this.parseOutput(raw);

      if (Object.keys(files).length === 0) {
        lastErrors = ["Failed to parse output: no valid JSON files object found in response."];
        continue;
      }

      // Run quality gates if provided
      if (this.qualityGates) {
        const errors = await this.qualityGates.check(files);
        if (errors.length > 0) {
          lastErrors = errors;
          continue;
        }
      }

      return { success: true, files, attempts: attempt };
    }

    return {
      success: false,
      files: {},
      errors: lastErrors,
      attempts: this.maxRetries,
    };
  }

  /**
   * Build a prompt from a proposal and optional project context.
   */
  buildPrompt(proposal: Proposal, context?: ProjectContext): string {
    const sections: string[] = [];

    sections.push("# Code Generation Request");
    sections.push("");
    sections.push(`## Proposal: ${proposal.type}`);
    sections.push(`- Description: ${proposal.description}`);
    sections.push(`- Reasoning: ${proposal.reasoning}`);
    sections.push(`- Diff target: ${proposal.diff.target} (${proposal.diff.operation})`);
    sections.push(`- Diff summary: ${proposal.diff.summary}`);

    if (proposal.diff.definition) {
      sections.push("");
      sections.push("## Proposed Definition");
      sections.push("```json");
      sections.push(JSON.stringify(proposal.diff.definition, null, 2));
      sections.push("```");
    }

    if (context) {
      sections.push("");
      sections.push("## Project Context");

      if (context.entities.length > 0) {
        sections.push("");
        sections.push("### Existing Entities");
        for (const entity of context.entities) {
          sections.push(`- \`${entity.name}\`: fields [${entity.fields.join(", ")}]`);
        }
      }

      if (context.actions.length > 0) {
        sections.push("");
        sections.push("### Existing Actions");
        for (const action of context.actions) {
          sections.push(`- \`${action.name}\` (entity: ${action.entity})`);
        }
      }

      if (context.conventions) {
        sections.push("");
        sections.push("### Conventions");
        sections.push(context.conventions);
      }
    }

    sections.push("");
    sections.push("## LinchKit Conventions");
    sections.push(
      "- Use defineEntity() for entities, defineAction() for actions, defineRule() for rules",
    );
    sections.push("- Entity naming: snake_case");
    sections.push("- Action naming: verb_noun");
    sections.push("- TypeScript strict mode, no `any` types");

    sections.push("");
    sections.push("## Type-Specific Guidance");
    sections.push(typeGuidance[proposal.type]);

    sections.push("");
    sections.push("## Output Format");
    sections.push('Return a JSON object: `{ "files": { "path/to/file.ts": "file content" } }`');
    sections.push("Each key is a file path, each value is the full file content as a string.");

    return sections.join("\n");
  }

  /** Build a retry prompt that includes previous errors */
  private buildRetryPrompt(
    proposal: Proposal,
    context: ProjectContext | undefined,
    errors: string[],
  ): string {
    const errorSection = [
      "# RETRY — Previous Attempt Failed",
      "",
      "The previous code generation attempt had the following errors:",
      ...errors.map((e) => `- ${e}`),
      "",
      "Please fix these issues in your next attempt.",
      "",
    ].join("\n");

    return errorSection + this.buildPrompt(proposal, context);
  }

  /** Parse raw AI output into a files record */
  private parseOutput(raw: string): Record<string, string> {
    // Try direct JSON parse first
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && "files" in parsed) {
        const files = parsed.files;
        if (files && typeof files === "object" && !Array.isArray(files)) {
          return files as Record<string, string>;
        }
      }
    } catch {
      // Fall through to markdown extraction
    }

    // Try extracting from ```json ... ``` blocks
    const jsonBlockRegex = /```json\s*\n([\s\S]*?)\n```/;
    const match = raw.match(jsonBlockRegex);
    if (match?.[1]) {
      try {
        const parsed = JSON.parse(match[1]) as Record<string, unknown>;
        if (parsed && typeof parsed === "object" && "files" in parsed) {
          const files = parsed.files;
          if (files && typeof files === "object" && !Array.isArray(files)) {
            return files as Record<string, string>;
          }
        }
      } catch {
        // Unparseable
      }
    }

    return {};
  }
}
