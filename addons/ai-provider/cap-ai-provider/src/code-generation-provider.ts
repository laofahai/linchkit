/**
 * CodeGenerationProvider implementation (G5 Phase 1).
 *
 * Implements core's `CodeGenerationProvider` seam. The interface in
 * `@linchkit/core` is documented as "implemented by cap-ai-provider", but no
 * implementation existed. This is a thin adapter over the configured
 * {@link AIService} (GLM / zhipu / etc. per `linchkit.config`), intended for the
 * proposal code-generation pipeline that materializes the irreducibly-code parts
 * of a proposal — action / event-handler / flow logic bodies that a declarative
 * `ChangeDefinition` cannot express — into TypeScript source.
 *
 * SAFETY BOUNDARY ("AI never modifies production directly"): this only PRODUCES
 * candidate source as a string. It never writes files, runs code, or touches the
 * approval / graduation path. Generated source must flow through validation
 * (build + quality gates) and double human review (draft review + graduation PR)
 * before it can land.
 */

import type { AICompletionOptions, AIMessage, AIService, AITaskType } from "@linchkit/core";
import type { CodeGenerationProvider } from "@linchkit/core/server";

export interface CodeGenerationProviderOptions {
  /**
   * Model alias (`fast` / `standard` / `advanced`) or a full model id. Omit to
   * let the AIService pick its configured default provider/model.
   */
  model?: string;
  /** Sampling temperature. Defaults to 0 — code generation should be deterministic. */
  temperature?: number;
  /** Max output tokens for a single generation. */
  maxTokens?: number;
  /** Task-type hint for model routing. Defaults to `"code"`. */
  taskType?: AITaskType;
  /** Tenant id for BYOK (bring-your-own-key) config resolution. */
  tenantId?: string;
}

/**
 * Build a {@link CodeGenerationProvider} backed by a configured {@link AIService}.
 *
 * `generateCode(prompt, context?)` sends `context` as a system message (when
 * non-empty) and `prompt` as the user message, returning the model's raw text
 * content. It throws when the AIService is not configured, so the caller's retry
 * / quality-gate loop surfaces a clear failure instead of silently treating an
 * empty completion as generated code.
 */
export function createCodeGenerationProvider(
  ai: AIService,
  options: CodeGenerationProviderOptions = {},
): CodeGenerationProvider {
  return {
    async generateCode(prompt: string, context?: string): Promise<string> {
      if (!ai.configured) {
        throw new Error(
          "CodeGenerationProvider: AIService is not configured — cannot generate code.",
        );
      }

      const messages: AIMessage[] = [];
      if (context && context.trim().length > 0) {
        messages.push({ role: "system", content: context });
      }
      messages.push({ role: "user", content: prompt });

      const completion: AICompletionOptions = {
        messages,
        temperature: options.temperature ?? 0,
        taskType: options.taskType ?? "code",
      };
      if (options.model) completion.model = options.model;
      if (options.maxTokens !== undefined) completion.maxTokens = options.maxTokens;
      if (options.tenantId) completion.tenantId = options.tenantId;

      const result = await ai.complete(completion);
      return result.content;
    },
  };
}
