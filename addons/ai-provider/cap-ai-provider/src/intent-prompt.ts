/**
 * Intent Resolver — System prompt builder
 *
 * Builds the system prompt sent to the AI for natural-language → action
 * proposal resolution. Kept in its own file so future PRs can tune the
 * prompt without touching the resolver pipeline.
 *
 * Spec 52 §2.2 — Intent Resolution.
 */

/** Compact action description suitable for embedding in the system prompt. */
export interface ActionCatalogEntry {
  /** Action name (e.g. "create_purchase_request") */
  name: string;
  /** Entity name the action operates on */
  entity: string;
  /** Human-readable label */
  label: string;
  /** Optional description / promptHints joined for the AI */
  description?: string;
  /** Input parameter descriptors */
  inputFields: Array<{
    name: string;
    type: string;
    required: boolean;
    label?: string;
    description?: string;
  }>;
}

/**
 * Build the system prompt for intent resolution.
 *
 * The prompt:
 *  - Lists the available actions (already filtered by scope).
 *  - Instructs the AI to choose at most one action and emit JSON.
 *  - Explicitly tells the AI to refuse (action: null) when no good match
 *    exists — never invent an action.
 *  - Asks the AI for a confidence score and explanation suitable for UI.
 */
export function buildIntentSystemPrompt(catalog: ActionCatalogEntry[]): string {
  const actionList =
    catalog.length > 0
      ? catalog
          .map((a) => {
            const fields =
              a.inputFields.length > 0
                ? a.inputFields
                    .map(
                      (f) =>
                        `      - ${f.name}: ${f.type}${f.required ? " (required)" : ""}${
                          f.label ? ` — ${f.label}` : ""
                        }`,
                    )
                    .join("\n")
                : "      (no input fields)";
            const desc = a.description ? `\n    description: ${a.description}` : "";
            return `  - name: ${a.name}\n    entity: ${a.entity}\n    label: ${a.label}${desc}\n    inputFields:\n${fields}`;
          })
          .join("\n")
      : "  (no actions available in current scope)";

  return `You translate a single user message into ONE concrete LinchKit action proposal.

Available actions (JSON-like outline — name, entity, label, optional description, and input fields):
${actionList}

Rules:
1. Pick at most ONE action from the list above. NEVER invent an action that is not listed.
2. If no listed action is a reasonable fit, set "action" to null and explain in plain English what was unclear.
3. Extract input parameters that the user explicitly stated. Do NOT guess or hallucinate values.
4. Use only field names that appear in the chosen action's "inputFields" list. Drop anything else.
5. Provide a confidence score in [0, 1] reflecting how confident you are that this is the user's intent.
6. Provide a one-sentence English explanation suitable for showing to the user inside a confirmation card.
7. Return STRICT JSON only — no prose, no Markdown fences. The JSON shape MUST be:
   {
     "action": "<action_name or null>",
     "input": { "<field>": <value>, ... },
     "confidence": <number between 0 and 1>,
     "explanation": "<short human-readable string>"
   }
`;
}
