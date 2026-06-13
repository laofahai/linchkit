/**
 * cap-adapter-a2a configuration schema
 *
 * Declares config keys for the A2A (Agent-to-Agent) protocol transport adapter.
 * See Spec 15 §6.5 and issue #89.
 */

import { defineConfigSchema } from "@linchkit/core/config";
import { z } from "zod";

export const capAdapterA2aConfig = defineConfigSchema("cap-adapter-a2a", {
  enabled: z.boolean().default(false).describe("Enable the A2A transport adapter"),
  port: z.coerce.number().default(3003).describe("Port for the A2A HTTP server"),
  basePath: z.string().default("/a2a").describe("Base path the A2A endpoints are mounted under"),

  // AgentCard metadata — used to populate the /.well-known/agent-card.json document
  agentName: z
    .string()
    .default("LinchKit")
    .describe("Display name of this agent published in the A2A AgentCard"),
  agentDescription: z
    .string()
    .default("AI-native software capability runtime")
    .describe("Human-readable description published in the A2A AgentCard"),
  agentUrl: z
    .string()
    .url()
    .default("http://localhost:3003")
    .describe("Canonical URL where this agent accepts A2A requests"),
  agentVersion: z
    .string()
    .default("0.0.1")
    .describe("Agent implementation version (semver) published in the A2A AgentCard"),
  agentDocumentationUrl: z
    .string()
    .url()
    .optional()
    .describe("Optional documentation URL published in the A2A AgentCard"),
  agentProviderOrg: z
    .string()
    .optional()
    .describe("Optional hosting organization name published in the A2A AgentCard"),
});
