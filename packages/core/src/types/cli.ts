/**
 * CLI Command type definitions
 *
 * Capabilities can register CLI commands via extensions.commands.
 * Commands are organized by namespace (e.g. 'server', 'mcp').
 * CLI dynamically builds the command tree from loaded capabilities.
 */

import type { CapabilityDefinition } from "./capability";

/** CLI command registered by a capability */
export interface CliCommand {
  /** Command name (e.g. 'dev', 'start', 'export') */
  name: string;
  /**
   * Namespace for grouping (optional).
   * - undefined: top-level command → `linch <name>`
   * - 'server': → `linch server <name>`
   * - 'mcp': → `linch mcp <name>`
   */
  namespace?: string;
  /** Human-readable description */
  description: string;
  /** Command handler */
  handler: (ctx: CliCommandContext) => Promise<void> | void;
  /** Argument definitions */
  args?: Record<string, CliArgDefinition>;
  /** If true, this is the default command for its namespace (allows `linch server` without subcommand) */
  isDefault?: boolean;
  /** If true, command is hidden in production mode */
  devOnly?: boolean;
  /** Usage examples for help output and AI discovery */
  examples?: string[];
  /** If true, command uses interactive prompts (not suitable for CI/headless) */
  interactive?: boolean;
}

/** CLI argument definition */
export interface CliArgDefinition {
  type: "string" | "boolean" | "number";
  description: string;
  default?: string | boolean | number;
  required?: boolean;
  /** Short flag alias (e.g. "p" for --port → -p) */
  alias?: string;
}

/** Context passed to CLI command handlers */
export interface CliCommandContext {
  /** Parsed command-line arguments */
  args: Record<string, unknown>;
  /** Loaded LinchKit config */
  config: Record<string, unknown>;
  /** All loaded capabilities */
  capabilities: CapabilityDefinition[];
  /** Current working directory */
  cwd: string;
}
