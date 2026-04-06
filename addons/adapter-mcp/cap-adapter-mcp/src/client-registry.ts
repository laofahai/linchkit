/**
 * McpClientRegistry — High-level service for MCP client management
 *
 * Wraps McpClientStore with:
 * - Secret hashing via Bun.password (argon2)
 * - Token-based actor resolution (clientId:secret format)
 * - Tool filtering based on client ToolPolicy
 * - Fallback to simple bearer token for backward compatibility
 */

import type { Actor, ActorType } from "@linchkit/core";
import type { McpClientStore } from "./client-store";
import type { CreateMcpClientInput, McpClient, ToolPolicy, UpdateMcpClientInput } from "./types";

/** Result of resolving an actor from a token */
export interface ResolvedMcpClient {
  actor: Actor;
  client: McpClient;
}

/** Tool name → category mapping for policy filtering */
const TOOL_CATEGORIES: Record<string, string> = {
  list_entities: "introspection",
  get_entity: "introspection",
  describe_entity: "introspection",
  list_actions: "introspection",
  get_rules: "introspection",
  get_state_machine: "introspection",
  query: "query",
  ontology_overview: "ontology",
  search_ontology: "ontology",
  check_ai_boundary: "ai_security",
  get_ai_usage: "ai_security",
  sanitize_prompt: "ai_security",
  ai_audit_summary: "ai_security",
  scaffold_capability: "scaffold",
  scaffold_action: "scaffold",
  scaffold_rule: "scaffold",
  get_capability_docs: "docs",
  search_docs: "docs",
  mcp_list_clients: "management",
  mcp_create_client: "management",
  mcp_update_client: "management",
  mcp_toggle_client: "management",
  mcp_rotate_secret: "management",
  mcp_usage_stats: "management",
};

/** Default actor returned for simple bearer token auth */
const _DEFAULT_MCP_ACTOR: Actor = {
  type: "ai",
  id: "mcp-default",
  name: "MCP Client",
  groups: ["ai_agent"],
};

/** Get the category for a tool name; unknown tools are "actions" */
function getToolCategory(toolName: string): string {
  return TOOL_CATEGORIES[toolName] ?? "actions";
}

/** Generate a prefixed random secret */
function generateSecret(): string {
  return `mcp_${crypto.randomUUID()}`;
}

export interface McpClientRegistryOptions {
  /** Legacy simple bearer token for backward compatibility */
  simpleBearerToken?: string;
}

export class McpClientRegistry {
  constructor(
    private store: McpClientStore,
    private options?: McpClientRegistryOptions,
  ) {}

  // ── Authentication ───────────────────────────────────────

  /**
   * Resolve an Actor from a bearer token.
   *
   * Token format: "clientId:clientSecret"
   * Fallback: if no registered clients match and simpleBearerToken is set,
   * try exact match and return default MCP_ACTOR.
   */
  async resolveActor(token: string): Promise<ResolvedMcpClient | null> {
    // Try clientId:secret format
    const colonIdx = token.indexOf(":");
    if (colonIdx > 0) {
      const clientId = token.substring(0, colonIdx);
      const secret = token.substring(colonIdx + 1);
      const client = await this.store.findByClientId(clientId);

      if (client) {
        // Verify secret
        const valid = await Bun.password.verify(secret, client.secretHash);
        if (!valid) return null;

        // Check enabled
        if (!client.enabled) return null;

        // Check expiry
        if (client.expiresAt && client.expiresAt < new Date()) return null;

        // Touch last used (fire-and-forget)
        this.store.touchLastUsed(client.id).catch(() => {});

        return {
          actor: {
            type: client.actorType as ActorType,
            id: client.actorId,
            name: client.actorName,
            groups: client.actorGroups,
          },
          client,
        };
      }
    }

    // Fallback: simple bearer token (no associated client)
    if (this.options?.simpleBearerToken && token === this.options.simpleBearerToken) {
      return null;
    }

    return null;
  }

  // ── CRUD ─────────────────────────────────────────────────

  /**
   * Create a new MCP client. Returns the client record and the plaintext secret.
   * The secret is only returned once — it is hashed before storage.
   */
  async createClient(input: CreateMcpClientInput): Promise<{ client: McpClient; secret: string }> {
    const secret = generateSecret();
    const secretHash = await Bun.password.hash(secret);
    const now = new Date();

    const client: McpClient = {
      id: crypto.randomUUID(),
      name: input.name,
      description: input.description,
      clientId: input.clientId,
      secretHash,
      actorType: input.actorType ?? "ai",
      actorId: input.actorId ?? `mcp-${input.clientId}`,
      actorName: input.actorName ?? input.name,
      actorGroups: input.actorGroups ?? ["ai_agent"],
      toolPolicy: input.toolPolicy ?? { mode: "allow_all", tools: [] },
      enabled: true,
      expiresAt: input.expiresAt,
      createdAt: now,
      updatedAt: now,
    };

    await this.store.create(client);
    return { client, secret };
  }

  /** Update an existing MCP client */
  async updateClient(id: string, input: UpdateMcpClientInput): Promise<McpClient> {
    const existing = await this.store.findById(id);
    if (!existing) {
      throw new Error(`MCP client not found: ${id}`);
    }

    const updates: Partial<McpClient> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.description !== undefined) updates.description = input.description;
    if (input.actorType !== undefined) updates.actorType = input.actorType;
    if (input.actorId !== undefined) updates.actorId = input.actorId;
    if (input.actorName !== undefined) updates.actorName = input.actorName;
    if (input.actorGroups !== undefined) updates.actorGroups = input.actorGroups;
    if (input.toolPolicy !== undefined) updates.toolPolicy = input.toolPolicy;
    if (input.enabled !== undefined) updates.enabled = input.enabled;
    if (input.expiresAt !== undefined) updates.expiresAt = input.expiresAt;

    await this.store.update(id, updates);

    const updated = await this.store.findById(id);
    if (!updated) {
      throw new Error(`MCP client not found after update: ${id}`);
    }
    return updated;
  }

  /** Delete an MCP client */
  async deleteClient(id: string): Promise<void> {
    await this.store.delete(id);
  }

  /** Get an MCP client by internal ID */
  async getClient(id: string): Promise<McpClient | null> {
    return this.store.findById(id);
  }

  /** List MCP clients with optional filter */
  async listClients(filter?: { enabled?: boolean }): Promise<McpClient[]> {
    return this.store.list(filter);
  }

  /**
   * Rotate a client's secret. Returns the new plaintext secret.
   * The old secret becomes invalid immediately.
   */
  async rotateSecret(id: string): Promise<{ clientId: string; secret: string }> {
    const existing = await this.store.findById(id);
    if (!existing) {
      throw new Error(`MCP client not found: ${id}`);
    }

    const secret = generateSecret();
    const secretHash = await Bun.password.hash(secret);
    await this.store.update(id, { secretHash } as Partial<McpClient>);

    return { clientId: existing.clientId, secret };
  }

  /** Enable or disable an MCP client */
  async toggleClient(id: string, enabled: boolean): Promise<McpClient> {
    return this.updateClient(id, { enabled });
  }

  // ── Tool Filtering ───────────────────────────────────────

  /**
   * Check if a single tool is allowed by a ToolPolicy (defense in depth).
   */
  isToolAllowed(toolName: string, policy: ToolPolicy, defaultCategory?: string): boolean {
    const dummy = { name: toolName, ...(defaultCategory ? {} : {}) };
    return this.filterTools([dummy], policy).length > 0;
  }

  /**
   * Filter a list of tools based on the client's ToolPolicy.
   *
   * - allow_all: return all tools
   * - allowlist: only tools in the list or enabled categories
   * - denylist: all tools except those in the list or disabled categories
   */
  filterTools<T extends { name: string }>(tools: T[], policy: ToolPolicy): T[] {
    if (policy.mode === "allow_all") {
      return tools;
    }

    const explicitTools = new Set(policy.tools);
    const categories = policy.categories;

    if (policy.mode === "allowlist") {
      return tools.filter((tool) => {
        // Explicit tool name match
        if (explicitTools.has(tool.name)) return true;
        // Category match
        if (categories) {
          const cat = getToolCategory(tool.name);
          return categories[cat as keyof typeof categories] === true;
        }
        return false;
      });
    }

    // denylist mode
    return tools.filter((tool) => {
      // Explicit tool name deny
      if (explicitTools.has(tool.name)) return false;
      // Category deny
      if (categories) {
        const cat = getToolCategory(tool.name);
        if (categories[cat as keyof typeof categories] === false) return false;
      }
      return true;
    });
  }
}
