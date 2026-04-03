/**
 * InMemoryMcpClientStore — Map-based in-memory implementation
 *
 * For development/testing without PostgreSQL. No persistence across restarts.
 */

import type { McpClientStore } from "./client-store";
import type { McpClient } from "./types";

export class InMemoryMcpClientStore implements McpClientStore {
  private clients = new Map<string, McpClient>();

  async findById(id: string): Promise<McpClient | null> {
    return this.clients.get(id) ?? null;
  }

  async findByClientId(clientId: string): Promise<McpClient | null> {
    for (const client of this.clients.values()) {
      if (client.clientId === clientId) {
        return client;
      }
    }
    return null;
  }

  async list(filter?: { enabled?: boolean }): Promise<McpClient[]> {
    let results = Array.from(this.clients.values());
    if (filter?.enabled !== undefined) {
      results = results.filter((c) => c.enabled === filter.enabled);
    }
    return results;
  }

  async create(client: McpClient): Promise<void> {
    this.clients.set(client.id, { ...client });
  }

  async update(id: string, data: Partial<McpClient>): Promise<void> {
    const existing = this.clients.get(id);
    if (!existing) {
      throw new Error(`MCP client not found: ${id}`);
    }
    this.clients.set(id, { ...existing, ...data, id, updatedAt: new Date() });
  }

  async delete(id: string): Promise<void> {
    if (!this.clients.has(id)) {
      throw new Error(`MCP client not found: ${id}`);
    }
    this.clients.delete(id);
  }

  async touchLastUsed(id: string): Promise<void> {
    const existing = this.clients.get(id);
    if (existing) {
      existing.lastUsedAt = new Date();
    }
  }

  /** Clear all data (test utility) */
  clear(): void {
    this.clients.clear();
  }
}
