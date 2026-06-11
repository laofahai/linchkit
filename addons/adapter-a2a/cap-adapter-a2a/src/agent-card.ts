/**
 * A2A AgentCard generator for cap-adapter-a2a.
 *
 * Reads entities and actions from the LinchKit TransportContext and produces
 * an A2A v1.0 compliant AgentCard document. Pure function — no side effects,
 * no external dependencies beyond @linchkit/core types.
 *
 * Each exposed LinchKit Action is mapped to an A2A Skill:
 *   - action.name          → skill.id
 *   - action.label         → skill.name
 *   - action.description   → skill.description
 *   - action.entity        → skill.tags[0]
 *
 * Filtering: actions with `exposure.a2a === false` or `exposure.internal ===
 * true` are excluded. All other actions (including those with no exposure
 * config) are exposed — the safe default for the spike slice.
 *
 * Ref: Spec 15 §6.5, issue #89
 */

import type { ActionDefinition } from "@linchkit/core";
import type { AgentCard, AgentSkill } from "./types";

export interface AgentCardOptions {
  /** Agent display name */
  name: string;
  /** Human-readable description */
  description: string;
  /** Canonical URL where this agent accepts A2A requests */
  url: string;
  /** Agent implementation version (semver) */
  version: string;
  /** Optional documentation URL */
  documentationUrl?: string;
  /** Optional hosting organization */
  providerOrg?: string;
  /** Actions to map to skills */
  actions: ActionDefinition[];
}

/**
 * Determine whether an action should be exposed as an A2A skill.
 *
 * Rules (conservatively follows the MCP exposure pattern):
 * - Explicitly excluded: `exposure.a2a === false`
 * - Explicitly excluded: `exposure.internal === true`
 * - If `exposure === "all"` → include
 * - Any other unexpected string value → exclude (fail-closed for unknown exposure types)
 * - Otherwise include (open default for the spike)
 */
export function isA2aExposed(action: ActionDefinition): boolean {
  const exp = action.exposure;
  if (!exp) return true;
  // Fail-closed: only the known "all" shorthand is accepted; unknown strings are excluded.
  if (typeof exp === "string") return exp === "all";
  if (exp.internal === true) return false;
  if (exp.a2a === false) return false;
  return true;
}

/**
 * Map a single LinchKit ActionDefinition to an A2A v1.0 AgentSkill.
 */
export function actionToSkill(action: ActionDefinition): AgentSkill {
  return {
    id: action.name,
    name: action.label || action.name,
    description: action.description ?? `Execute the ${action.name} action`,
    tags: action.entity ? [action.entity] : [],
    inputModes: ["application/json"],
    outputModes: ["application/json"],
  };
}

/**
 * Generate an A2A v1.0 AgentCard from the provided options.
 *
 * Returns a fully-typed AgentCard object ready to be serialized and served at
 * `/.well-known/agent-card.json`. The caller is responsible for HTTP serving
 * (deferred to when elysia is wired into the transport).
 */
export function generateAgentCard(options: AgentCardOptions): AgentCard {
  const { name, description, url, version, documentationUrl, providerOrg, actions } = options;

  const skills: AgentSkill[] = actions.filter(isA2aExposed).map(actionToSkill);

  return {
    protocolVersion: "1.0",
    name,
    description,
    url,
    version,
    ...(documentationUrl && { documentationUrl }),
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills,
    ...(providerOrg && {
      provider: {
        organization: providerOrg,
      },
    }),
  };
}
