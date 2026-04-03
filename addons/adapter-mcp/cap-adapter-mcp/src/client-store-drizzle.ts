/**
 * DrizzleMcpClientStore — PostgreSQL-backed MCP client store via Drizzle ORM
 *
 * Persists MCP client records to the _linchkit.mcp_clients system table.
 */

import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { McpClientStore } from "./client-store";
import { mcpClientsTable } from "./system-tables";
import type { McpClient, ToolPolicy } from "./types";

/** Map a Drizzle row to an McpClient domain object */
function rowToClient(row: typeof mcpClientsTable.$inferSelect): McpClient {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    clientId: row.clientId,
    secretHash: row.secretHash,
    actorType: row.actorType as "ai" | "service",
    actorId: row.actorId,
    actorName: row.actorName,
    actorGroups: (row.actorGroups as string[]) ?? ["ai_agent"],
    toolPolicy: (row.toolPolicy as ToolPolicy) ?? { mode: "allow_all", tools: [] },
    enabled: row.enabled,
    expiresAt: row.expiresAt ?? undefined,
    lastUsedAt: row.lastUsedAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleMcpClientStore implements McpClientStore {
  constructor(private db: PostgresJsDatabase) {}

  async findById(id: string): Promise<McpClient | null> {
    const rows = await this.db
      .select()
      .from(mcpClientsTable)
      .where(eq(mcpClientsTable.id, id))
      .limit(1);
    return rows[0] ? rowToClient(rows[0]) : null;
  }

  async findByClientId(clientId: string): Promise<McpClient | null> {
    const rows = await this.db
      .select()
      .from(mcpClientsTable)
      .where(eq(mcpClientsTable.clientId, clientId))
      .limit(1);
    return rows[0] ? rowToClient(rows[0]) : null;
  }

  async list(filter?: { enabled?: boolean }): Promise<McpClient[]> {
    const condition =
      filter?.enabled !== undefined ? eq(mcpClientsTable.enabled, filter.enabled) : undefined;
    const rows = await this.db
      .select()
      .from(mcpClientsTable)
      .where(condition);
    return rows.map(rowToClient);
  }

  async create(client: McpClient): Promise<void> {
    await this.db.insert(mcpClientsTable).values({
      id: client.id,
      name: client.name,
      description: client.description ?? null,
      clientId: client.clientId,
      secretHash: client.secretHash,
      actorType: client.actorType,
      actorId: client.actorId,
      actorName: client.actorName,
      actorGroups: client.actorGroups,
      toolPolicy: client.toolPolicy,
      enabled: client.enabled,
      expiresAt: client.expiresAt ?? null,
      lastUsedAt: client.lastUsedAt ?? null,
      createdAt: client.createdAt,
      updatedAt: client.updatedAt,
    });
  }

  async update(id: string, data: Partial<McpClient>): Promise<void> {
    const updateValues: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name !== undefined) updateValues.name = data.name;
    if (data.description !== undefined) updateValues.description = data.description;
    if (data.secretHash !== undefined) updateValues.secretHash = data.secretHash;
    if (data.actorType !== undefined) updateValues.actorType = data.actorType;
    if (data.actorId !== undefined) updateValues.actorId = data.actorId;
    if (data.actorName !== undefined) updateValues.actorName = data.actorName;
    if (data.actorGroups !== undefined) updateValues.actorGroups = data.actorGroups;
    if (data.toolPolicy !== undefined) updateValues.toolPolicy = data.toolPolicy;
    if (data.enabled !== undefined) updateValues.enabled = data.enabled;
    if (data.expiresAt !== undefined) updateValues.expiresAt = data.expiresAt;
    if (data.lastUsedAt !== undefined) updateValues.lastUsedAt = data.lastUsedAt;

    await this.db.update(mcpClientsTable).set(updateValues).where(eq(mcpClientsTable.id, id));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(mcpClientsTable).where(eq(mcpClientsTable.id, id));
  }

  async touchLastUsed(id: string): Promise<void> {
    await this.db
      .update(mcpClientsTable)
      .set({ lastUsedAt: new Date() })
      .where(eq(mcpClientsTable.id, id));
  }
}
