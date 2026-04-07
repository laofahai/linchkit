/**
 * Template re-exports for linch init scaffolding
 */

export {
  linchkitConfigTemplate,
  packageJsonTemplate,
  tsconfigTemplate,
  envExampleTemplate,
  gitignoreTemplate,
} from "./project-templates.js";

export {
  claudeMdTemplate,
  agentsMdTemplate,
  agentsUserMdTemplate,
} from "./agent-templates.js";

export {
  mcpJsonTemplate,
  cursorRulesTemplate,
  codexMdTemplate,
  traeRulesTemplate,
  copilotInstructionsTemplate,
} from "./ai-tool-templates.js";

export type { SkillDefinition } from "./skill-templates.js";
export { linchkitSkills } from "./skill-templates.js";
