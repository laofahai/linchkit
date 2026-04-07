/**
 * Template re-exports for linch init scaffolding
 */

export {
  agentsMdTemplate,
  agentsUserMdTemplate,
  claudeMdTemplate,
} from "./agent-templates.js";
export {
  codexMdTemplate,
  copilotInstructionsTemplate,
  cursorRulesTemplate,
  mcpJsonTemplate,
  traeRulesTemplate,
} from "./ai-tool-templates.js";
export {
  envExampleTemplate,
  gitignoreTemplate,
  linchkitConfigTemplate,
  packageJsonTemplate,
  tsconfigTemplate,
} from "./project-templates.js";

export type { SkillDefinition } from "./skill-templates.js";
export { linchkitSkills } from "./skill-templates.js";
