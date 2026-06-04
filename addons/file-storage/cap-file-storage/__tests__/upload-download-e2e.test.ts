/**
 * End-to-end upload → store → download/delete round-trip for cap-file-storage.
 *
 * Unlike the sibling tests, this drives the REAL action handlers through the
 * REAL CommandLayer pipeline (auth → exposure → permission → tenant → action)
 * against a REAL ActionExecutor + InMemoryStore + a REAL LocalStorageAdapter
 * writing to a temp directory on disk. Nothing is mocked:
 *
 * - base64 decode/encode runs in the actions
 * - the server-side, tenant-prefixed storage key is generated for real
 * - bytes are written to / read from the local filesystem by the adapter
 * - the `file` metadata record is persisted in the data provider
 * - domain events (file.uploaded / file.deleted) flow through a real EventBus
 *
 * This is the integration seam the unit tests leave uncovered: each of those
 * exercises either the adapter alone (no actions) or the capability metadata
 * (no execution), so an action-level wiring bug (wrong field on create,
 * checksum/size divergence, adapter-name guard, event payload) would ship
 * undetected.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionDefinition, Actor, EventRecord } from "@linchkit/core";
import {
  type CommandLayer,
  createActionExecutor,
  createCommandLayer,
  createEventBus,
  type EventBus,
  InMemoryExecutionLogger,
  InMemoryStore,
} from "@linchkit/core/server";
import { deleteFileAction } from "../src/actions/delete_file";
import { downloadFileAction } from "../src/actions/download_file";
import { uploadFileAction } from "../src/actions/upload_file";
import { LocalStorageAdapter } from "../src/adapters/local-adapter";
import { resetStorageAdapter, setStorageAdapter } from "../src/storage-registry";

const ACTOR: Actor = { type: "human", id: "user_42", groups: [] };
const TENANT = "tenant_a";

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

describe("cap-file-storage upload → download/delete e2e (real pipeline)", () => {
  let root: string | undefined;
  let commandLayer: CommandLayer;
  let eventBus: EventBus;
  let captured: EventRecord[];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "cap-file-storage-e2e-"));
    setStorageAdapter(new LocalStorageAdapter({ rootDir: root }));
  });

  afterAll(async () => {
    resetStorageAdapter();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    // Fresh runtime per test — a new EventBus + InMemoryStore + CommandLayer —
    // gives full isolation and makes subscription leaks impossible, so no
    // afterEach teardown is needed. The storage adapter / temp dir is shared
    // (tests use unique file ids).
    captured = [];
    eventBus = createEventBus().bus;
    const executor = createActionExecutor({
      dataProvider: new InMemoryStore(),
      executionLogger: new InMemoryExecutionLogger(),
      eventBus,
    });
    // Register the three real action definitions on the real registry.
    for (const action of [
      uploadFileAction,
      downloadFileAction,
      deleteFileAction,
    ] as ActionDefinition[]) {
      executor.registry.register(action);
    }
    commandLayer = createCommandLayer({ executor });

    // Subscribe synchronously so emitted events are captured before
    // `execute()` resolves (the default async path would race the assertion).
    eventBus.subscribe(
      "file.uploaded",
      (e) => {
        captured.push(e);
      },
      { sync: true },
    );
    eventBus.subscribe(
      "file.deleted",
      (e) => {
        captured.push(e);
      },
      { sync: true },
    );
  });

  it("round-trips bytes and metadata through upload then download", async () => {
    const payload = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const expectedChecksum = Buffer.from(await crypto.subtle.digest("SHA-256", payload)).toString(
      "hex",
    );

    const upload = await commandLayer.execute({
      command: "upload_file",
      input: { name: "blob.bin", mime: "application/octet-stream", data_base64: toBase64(payload) },
      actor: ACTOR,
      tenantId: TENANT,
    });

    expect(upload.success).toBe(true);
    const record = upload.data as Record<string, unknown>;
    const fileId = record.id as string;

    // Metadata persisted correctly by the real ctx.create("file", …) call.
    expect(typeof fileId).toBe("string");
    expect(record.name).toBe("blob.bin");
    expect(record.mime).toBe("application/octet-stream");
    expect(record.size).toBe(payload.byteLength);
    expect(record.adapter).toBe("local");
    expect(record.checksum).toBe(expectedChecksum);
    expect(record.uploaded_by).toBe(ACTOR.id);
    // Server-generated key MUST be scoped under the tenant prefix and MUST NOT
    // echo the original filename (anti cross-tenant-overwrite invariant).
    expect((record.path as string).startsWith(`${TENANT}/`)).toBe(true);
    expect(record.path as string).not.toContain("blob.bin");

    // file.uploaded domain event emitted with the expected payload.
    const uploadedEvent = captured.find((e) => e.type === "file.uploaded");
    expect(uploadedEvent).toBeDefined();
    expect(uploadedEvent?.payload.file_id).toBe(fileId);
    expect(uploadedEvent?.payload.size).toBe(payload.byteLength);

    // Download returns the exact bytes — read back off the real filesystem.
    const download = await commandLayer.execute({
      command: "download_file",
      input: { id: fileId },
      actor: ACTOR,
      tenantId: TENANT,
    });

    expect(download.success).toBe(true);
    const dl = download.data as Record<string, unknown>;
    expect(dl.id).toBe(fileId);
    expect(dl.name).toBe("blob.bin");
    expect(dl.mime).toBe("application/octet-stream");
    expect(dl.size).toBe(payload.byteLength);

    const returnedBytes = new Uint8Array(Buffer.from(dl.data_base64 as string, "base64"));
    expect(Array.from(returnedBytes)).toEqual(Array.from(payload));
  });

  it("round-trips UTF-8 text content end-to-end", async () => {
    const text = "héllo, 世界 — file storage e2e ✅";
    const payload = new TextEncoder().encode(text);

    const upload = await commandLayer.execute({
      command: "upload_file",
      input: { name: "note.txt", mime: "text/plain", data_base64: toBase64(payload) },
      actor: ACTOR,
      tenantId: TENANT,
    });
    expect(upload.success).toBe(true);
    const fileId = (upload.data as Record<string, unknown>).id as string;

    const download = await commandLayer.execute({
      command: "download_file",
      input: { id: fileId },
      actor: ACTOR,
      tenantId: TENANT,
    });
    expect(download.success).toBe(true);
    const dl = download.data as Record<string, unknown>;
    const decoded = new TextDecoder().decode(Buffer.from(dl.data_base64 as string, "base64"));
    expect(decoded).toBe(text);
  });

  it("deletes record and payload, after which download fails", async () => {
    const payload = new TextEncoder().encode("delete me");
    const upload = await commandLayer.execute({
      command: "upload_file",
      input: { name: "doomed.txt", mime: "text/plain", data_base64: toBase64(payload) },
      actor: ACTOR,
      tenantId: TENANT,
    });
    const fileId = (upload.data as Record<string, unknown>).id as string;

    const del = await commandLayer.execute({
      command: "delete_file",
      input: { id: fileId },
      actor: ACTOR,
      tenantId: TENANT,
    });
    expect(del.success).toBe(true);
    expect((del.data as Record<string, unknown>).deleted).toBe(true);

    // file.deleted domain event emitted.
    const deletedEvent = captured.find((e) => e.type === "file.deleted");
    expect(deletedEvent).toBeDefined();
    expect(deletedEvent?.payload.file_id).toBe(fileId);

    // The metadata record is gone, so download_file (ctx.get) now fails.
    const download = await commandLayer.execute({
      command: "download_file",
      input: { id: fileId },
      actor: ACTOR,
      tenantId: TENANT,
    });
    expect(download.success).toBe(false);
  });

  it("deleting a missing file is a successful no-op (idempotent)", async () => {
    const del = await commandLayer.execute({
      command: "delete_file",
      input: { id: "does_not_exist" },
      actor: ACTOR,
      tenantId: TENANT,
    });
    expect(del.success).toBe(true);
    const data = del.data as Record<string, unknown>;
    expect(data.deleted).toBe(false);
    expect(data.reason).toBe("not-found");
  });

  it("rejects an upload with a missing required field via the pipeline", async () => {
    const result = await commandLayer.execute({
      command: "upload_file",
      input: { name: "x.txt", mime: "text/plain" },
      actor: ACTOR,
      tenantId: TENANT,
    });
    expect(result.success).toBe(false);
  });
});
