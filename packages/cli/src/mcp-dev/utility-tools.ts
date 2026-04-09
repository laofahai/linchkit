/**
 * MCP Dev Server — Utility tools for project overview and health checks.
 */

import type { CapabilityDefinition } from "@linchkit/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CollectedDefinitions } from "../commands/startup/collect-capabilities";

/** Register all utility tools on the MCP server. */
export function registerUtilityTools(
  server: McpServer,
  defs: CollectedDefinitions,
  capabilities: CapabilityDefinition[],
  projectRoot: string,
): void {
  // linchkit_project_overview
  server.registerTool(
    "linchkit_project_overview",
    {
      description:
        "Get full project summary: entity count, action count, relation count, capability count, states, rules, event handlers, views",
    },
    async () => {
      const overview = {
        projectRoot,
        counts: {
          entities: defs.entities.length,
          actions: defs.actions.length,
          relations: defs.links.length,
          capabilities: capabilities.length,
          states: defs.states.length,
          rules: defs.rules.length,
          eventHandlers: defs.eventHandlers.length,
          views: defs.views.length,
          interfaces: defs.interfaces.length,
        },
        entities: defs.entities.map((e) => e.name),
        capabilities: capabilities.map((c) => ({ name: c.name, type: c.type })),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(overview, null, 2) }] };
    },
  );

  // linchkit_doctor
  server.registerTool(
    "linchkit_doctor",
    {
      description: "Run linch doctor health checks and return results as JSON",
    },
    async () => {
      try {
        const proc = Bun.spawn(
          ["bun", "run", `${projectRoot}/packages/cli/src/index.ts`, "doctor", "--json"],
          {
            cwd: projectRoot,
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();

        // Try to parse JSON output from doctor
        try {
          const parsed = JSON.parse(stdout);
          return { content: [{ type: "text" as const, text: JSON.stringify(parsed, null, 2) }] };
        } catch {
          // If not valid JSON, return raw output
          return {
            content: [
              { type: "text" as const, text: stdout || stderr || "Doctor returned no output" },
            ],
          };
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Failed to run doctor: ${err instanceof Error ? err.message : String(err)}`,
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
