/**
 * GraphQL helpers for MCP client management.
 *
 * Uses plain fetch against /graphql (proxied in dev via Vite).
 */

// ── Generic GraphQL client ─────────────────────────────

interface GraphQLResponse<T = unknown> {
  data?: T;
  errors?: { message: string }[];
}

function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem("linchkit:token");
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  return {};
}

async function gqlQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch("/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify({ query, variables }),
  });
  const json: GraphQLResponse<T> = await res.json();
  if (json.errors && json.errors.length > 0) {
    throw new Error(json.errors[0]?.message ?? "Unknown GraphQL error");
  }
  if (!json.data) {
    throw new Error("No data returned from GraphQL");
  }
  return json.data;
}

// ── MCP Client types ───────────────────────────────────

export interface McpClient {
  id: string;
  name: string;
  description?: string;
  clientId: string;
  actorType?: string;
  actorId?: string;
  actorName?: string;
  actorGroups?: string[];
  toolPolicy?: ToolPolicy;
  enabled: boolean;
  expiresAt?: string;
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ToolPolicy {
  mode: "allow_all" | "categories" | "allowlist" | "denylist";
  categories?: string[];
  tools?: string[];
}

export interface CreateMcpClientResult {
  clientId: string;
  clientSecret: string;
}

// ── Queries & Mutations ────────────────────────────────

const MCP_CLIENT_FIELDS = `
	id name description clientId actorType actorId actorName actorGroups
	toolPolicy enabled expiresAt lastUsedAt createdAt updatedAt
`;

export async function fetchMcpClients(enabled?: boolean): Promise<McpClient[]> {
  const data = await gqlQuery<{ mcpClients: McpClient[] }>(
    `query McpClients($enabled: Boolean) {
			mcpClients(enabled: $enabled) { ${MCP_CLIENT_FIELDS} }
		}`,
    enabled !== undefined ? { enabled } : undefined,
  );
  return data.mcpClients;
}

export async function fetchMcpClient(id: string): Promise<McpClient | null> {
  const data = await gqlQuery<{ mcpClient: McpClient | null }>(
    `query McpClient($id: ID!) {
			mcpClient(id: $id) { ${MCP_CLIENT_FIELDS} }
		}`,
    { id },
  );
  return data.mcpClient;
}

export async function createMcpClient(input: {
  name: string;
  description?: string;
  actorGroups?: string[];
}): Promise<CreateMcpClientResult> {
  const data = await gqlQuery<{ createMcpClient: CreateMcpClientResult }>(
    `mutation CreateMcpClient($input: CreateMcpClientInput!) {
			createMcpClient(input: $input) { clientId clientSecret }
		}`,
    { input },
  );
  return data.createMcpClient;
}

export async function updateMcpClient(
  id: string,
  input: {
    name?: string;
    description?: string;
    actorGroups?: string[];
    toolPolicy?: ToolPolicy;
  },
): Promise<McpClient> {
  const data = await gqlQuery<{ updateMcpClient: McpClient }>(
    `mutation UpdateMcpClient($id: ID!, $input: UpdateMcpClientInput!) {
			updateMcpClient(id: $id, input: $input) { ${MCP_CLIENT_FIELDS} }
		}`,
    { id, input },
  );
  return data.updateMcpClient;
}

export async function deleteMcpClient(id: string): Promise<boolean> {
  const data = await gqlQuery<{ deleteMcpClient: boolean }>(
    `mutation DeleteMcpClient($id: ID!) {
			deleteMcpClient(id: $id)
		}`,
    { id },
  );
  return data.deleteMcpClient;
}

export async function rotateMcpClientSecret(id: string): Promise<CreateMcpClientResult> {
  const data = await gqlQuery<{ rotateMcpClientSecret: CreateMcpClientResult }>(
    `mutation RotateMcpClientSecret($id: ID!) {
			rotateMcpClientSecret(id: $id) { clientId clientSecret }
		}`,
    { id },
  );
  return data.rotateMcpClientSecret;
}

export async function toggleMcpClient(
  id: string,
  enabled: boolean,
): Promise<{ id: string; enabled: boolean }> {
  const data = await gqlQuery<{ toggleMcpClient: { id: string; enabled: boolean } }>(
    `mutation ToggleMcpClient($id: ID!, $enabled: Boolean!) {
			toggleMcpClient(id: $id, enabled: $enabled) { id enabled }
		}`,
    { id, enabled },
  );
  return data.toggleMcpClient;
}
