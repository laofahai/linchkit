/**
 * MCP Client Registry types
 *
 * TypeScript interfaces for MCP client management, authentication,
 * and tool policy configuration.
 */

/** Tool access policy for an MCP client */
export interface ToolPolicy {
  mode: "allow_all" | "allowlist" | "denylist";
  tools: string[];
  categories?: {
    introspection?: boolean;
    query?: boolean;
    actions?: boolean;
    ai_security?: boolean;
    scaffold?: boolean;
    ontology?: boolean;
    docs?: boolean;
    management?: boolean;
  };
}

/** Registered MCP client record */
export interface McpClient {
  id: string;
  name: string;
  description?: string;
  clientId: string;
  secretHash: string;
  actorType: "ai" | "service";
  actorId: string;
  actorName: string;
  actorGroups: string[];
  toolPolicy: ToolPolicy;
  enabled: boolean;
  expiresAt?: Date;
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Input for creating a new MCP client */
export interface CreateMcpClientInput {
  name: string;
  description?: string;
  clientId: string;
  actorType?: "ai" | "service";
  actorId?: string;
  actorName?: string;
  actorGroups?: string[];
  toolPolicy?: ToolPolicy;
  expiresAt?: Date;
}

/** Input for updating an existing MCP client */
export interface UpdateMcpClientInput {
  name?: string;
  description?: string;
  actorType?: "ai" | "service";
  actorId?: string;
  actorName?: string;
  actorGroups?: string[];
  toolPolicy?: ToolPolicy;
  enabled?: boolean;
  expiresAt?: Date;
}
