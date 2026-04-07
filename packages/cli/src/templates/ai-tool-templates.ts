/**
 * AI tool configuration templates: MCP, Cursor, Codex, Trae, Copilot
 */

export function mcpJsonTemplate(): string {
  return JSON.stringify(
    {
      mcpServers: {
        linchkit: {
          command: "bunx",
          args: ["linch", "mcp-dev", "--transport", "stdio"],
        },
      },
    },
    null,
    2,
  );
}

export function cursorRulesTemplate(projectName: string): string {
  return `# ${projectName} — Cursor Rules

Read AGENTS.md at the project root for full conventions, meta-model reference, and development workflow.

## Quick Reference
- Runtime: Bun (never Node/npx/npm)
- Language: TypeScript strict mode
- All definitions use \`defineXxx()\` functions
- Entity naming: snake_case
- Action naming: verb_noun
- Comments in English
- Run quality gates before committing: \`linch validate && bun run check && bun run typecheck && bun test\`
`;
}

export function codexMdTemplate(): string {
  return `# LinchKit Project

Read AGENTS.md at the project root for full conventions, meta-model reference, and development workflow.

Key rules:
- Runtime: Bun (never Node/npx/npm)
- TypeScript strict mode
- All definitions use \`defineXxx()\` functions
- Quality gates: \`linch validate && bun run check && bun run typecheck && bun test\`
`;
}

export function traeRulesTemplate(projectName: string): string {
  return `# ${projectName} — Trae Rules

Read AGENTS.md at the project root for full conventions, meta-model reference, and development workflow.

## Quick Reference
- Runtime: Bun (never Node/npx/npm)
- Language: TypeScript strict mode
- All definitions use \`defineXxx()\` functions
- Entity naming: snake_case
- Action naming: verb_noun
- Comments in English
- Run quality gates before committing: \`linch validate && bun run check && bun run typecheck && bun test\`
`;
}

export function copilotInstructionsTemplate(projectName: string): string {
  return `# ${projectName} — GitHub Copilot Instructions

This project uses LinchKit, an AI-Native Software Capability Runtime.

## Key Conventions
- **Runtime**: Bun — never use Node.js, npx, or npm
- **Language**: TypeScript strict mode, no \`any\` type
- **Definitions**: Use \`defineEntity()\`, \`defineAction()\`, \`defineRule()\`, \`defineState()\`, \`defineView()\`, \`defineRelation()\`
- **Entity naming**: snake_case (e.g. \`purchase_order\`)
- **Action naming**: verb_noun (e.g. \`approve_order\`)
- **Comments**: English
- **Capabilities**: Self-contained modules in \`addons/\` directory

## Quality Gates (must pass before commit)
1. \`linch validate\` — capability validation
2. \`bun run check\` — Biome lint + format
3. \`bun run typecheck\` — TypeScript strict check
4. \`bun test\` — all tests green

Read AGENTS.md for the full meta-model reference and development workflow.
`;
}
