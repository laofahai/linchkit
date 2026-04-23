/**
 * download_file action — read a file's payload via the active StorageAdapter.
 *
 * NOTE: Actions are the sole write entry, but are also used as the canonical
 * invocation for non-GraphQL reads that need side-channel work (permission
 * checks, audit logs). This action does not mutate state.
 *
 * Input:
 *   id — file record id (required)
 *
 * Output:
 *   id, name, mime, size, data_base64
 */

import { defineAction } from "@linchkit/core";
import { getStorageAdapter } from "../storage-registry";

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  // Bun/Node both ship globalThis.btoa.
  return btoa(binary);
}

export const downloadFileAction = defineAction({
  name: "download_file",
  entity: "file",
  label: "Download File",
  description: "Read a file's payload via its storage adapter",
  input: {
    id: {
      type: "string",
      label: "File ID",
      required: true,
    },
  },
  policy: {
    mode: "sync",
    transaction: false,
    idempotent: true,
  },
  exposure: { http: true, ui: true, cli: true, mcp: false },
  async handler(ctx) {
    const id = String(ctx.input.id ?? "").trim();
    if (!id) {
      throw new Error("File id is required");
    }

    const record = await ctx.get("file", id);

    const adapter = getStorageAdapter();
    const recordAdapter = record.adapter as string | undefined;
    if (recordAdapter && recordAdapter !== adapter.name) {
      throw new Error(
        `File record was stored by adapter "${recordAdapter}" but active adapter is "${adapter.name}"`,
      );
    }

    const data = await adapter.read(record.path as string);

    return {
      id: record.id,
      name: record.name,
      mime: record.mime,
      size: record.size,
      data_base64: encodeBase64(data),
    };
  },
});
