/**
 * McpClientStore interface
 *
 * Abstract storage layer for MCP client records.
 * Implementations: InMemoryMcpClientStore (dev), DrizzleMcpClientStore (production).
 */

import type { McpClient } from "./types";

export interface McpClientStore {
  findById(id: string): Promise<McpClient | null>;
  findByClientId(clientId: string): Promise<McpClient | null>;
  list(filter?: { enabled?: boolean }): Promise<McpClient[]>;
  create(client: McpClient): Promise<void>;
  update(id: string, data: Partial<McpClient>): Promise<void>;
  delete(id: string): Promise<void>;
  touchLastUsed(id: string): Promise<void>;
}
