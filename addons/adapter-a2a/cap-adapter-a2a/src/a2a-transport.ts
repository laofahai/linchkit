/**
 * a2a-transport — TransportAdapterDefinition for the A2A protocol.
 *
 * Phase-1 spike (issue #89, Spec 15 §6.5): generates the A2A v1.0 AgentCard
 * from the LinchKit TransportContext and logs it at start-up. HTTP serving of
 * `/.well-known/agent-card.json` is deferred to the next slice (requires
 * elysia to be present in the transport layer).
 *
 * When the transport later dispatches inbound agent messages to Actions it will
 * route them through `ctx.commandLayer.execute` (the sole write entry point),
 * never bypassing the CommandLayer middleware.
 */

import type { TransportAdapterDefinition, TransportContext } from "@linchkit/core";
import { generateAgentCard } from "./agent-card";
import { capAdapterA2aConfig } from "./config";

/**
 * The A2A transport definition registered via `extensions.transports`.
 *
 * Phase-1 implements AgentCard generation. The HTTP endpoint and JSON-RPC
 * task lifecycle are deferred to later slices (#89 S2+).
 */
export const a2aTransport: TransportAdapterDefinition = {
  name: "a2a",
  label: "Agent-to-Agent Protocol",
  factory: (ctx: TransportContext) => {
    const cfg = capAdapterA2aConfig.from(ctx);

    return {
      start: async () => {
        if (!cfg.enabled) {
          return;
        }

        // Generate the AgentCard so the mapping logic is validated at boot.
        // Serving via HTTP is deferred until elysia is wired into the transport.
        const card = generateAgentCard({
          name: cfg.agentName,
          description: cfg.agentDescription,
          url: cfg.agentUrl,
          version: cfg.agentVersion,
          documentationUrl: cfg.agentDocumentationUrl,
          providerOrg: cfg.agentProviderOrg,
          actions: ctx.actions,
        });

        console.log(
          `[cap-adapter-a2a] AgentCard generated: "${card.name}" v${card.version} ` +
            `with ${card.skills.length} skill(s). ` +
            `HTTP endpoint (${cfg.basePath}/.well-known/agent-card.json) deferred to next slice.`,
        );
      },
      stop: async () => {
        // No resources held in this slice.
      },
    };
  },
  config: {
    enabled: {
      type: "boolean",
      default: false,
      description: "Enable the A2A transport adapter",
    },
    port: {
      type: "number",
      default: 3003,
      description: "Port for the A2A HTTP server",
    },
    basePath: {
      type: "string",
      default: "/a2a",
      description: "Base path the A2A endpoints are mounted under",
    },
    agentName: {
      type: "string",
      default: "LinchKit",
      description: "Display name of this agent in the A2A AgentCard",
    },
    agentDescription: {
      type: "string",
      default: "AI-native software capability runtime",
      description: "Description of this agent in the A2A AgentCard",
    },
    agentUrl: {
      type: "string",
      default: "http://localhost:3003",
      description: "Canonical URL where this agent accepts A2A requests",
    },
    agentVersion: {
      type: "string",
      default: "0.0.1",
      description: "Agent implementation version (semver)",
    },
    agentDocumentationUrl: {
      type: "string",
      description: "Optional documentation URL in the AgentCard",
    },
    agentProviderOrg: {
      type: "string",
      description: "Optional hosting organization name in the AgentCard",
    },
  },
};
