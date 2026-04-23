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

    // Delete metadata first, then the payload. If adapter.delete fails the
    // record is already gone — the leftover blob is a harmless orphan that
    // a storage GC can reclaim. The reverse order (blob first, row second)
    // can leave an orphan row pointing at a missing blob, which breaks
    // download_file for every future request.
    await ctx.delete("file", id);
    await adapter.delete(record.path as string);

    ctx.emit("file.deleted", {
      file_id: id,
      deleted_by: ctx.actor.id,
    });

    return { deleted: true, id };
  },
});
