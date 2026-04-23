/**
 * delete_file action — remove both the file record and its payload.
 *
 * Idempotent: deleting a missing file succeeds. The adapter `delete()`
 * contract also requires idempotency.
 */

import { defineAction } from "@linchkit/core";
import { getStorageAdapter } from "../storage-registry";

export const deleteFileAction = defineAction({
  name: "delete_file",
  entity: "file",
  label: "Delete File",
  description: "Delete a file's record and payload",
  input: {
    id: {
      type: "string",
      label: "File ID",
      required: true,
    },
  },
  policy: {
    mode: "sync",
    transaction: true,
    idempotent: true,
  },
  exposure: { http: true, ui: true, cli: true, mcp: false },
  async handler(ctx) {
    const id = String(ctx.input.id ?? "").trim();
    if (!id) {
      throw new Error("File id is required");
    }

    // Idempotency: use `query` rather than `get` so a missing record is a
    // zero-length array instead of an exception. Transient errors
    // (DB unavailable, tenant-isolation reject, permission error, etc.) still
    // throw, which is what we want — callers must not see `deleted: false`
    // for a real failure.
    const rows = await ctx.query("file", { id });
    const [record] = rows;
    if (!record) {
      return { deleted: false, id, reason: "not-found" };
    }

    const adapter = getStorageAdapter();
    const recordAdapter = record.adapter as string | undefined;
    if (recordAdapter && recordAdapter !== adapter.name) {
      throw new Error(
        `File record was stored by adapter "${recordAdapter}" but active adapter is "${adapter.name}"`,
      );
    }

    // Delete payload first, then metadata. Adapter delete is idempotent.
    await adapter.delete(record.path as string);
    await ctx.delete("file", id);

    ctx.emit("file.deleted", {
      file_id: id,
      deleted_by: ctx.actor.id,
    });

    return { deleted: true, id };
  },
});
