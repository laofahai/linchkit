import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorageAdapter } from "../src/adapters/local-adapter";
import { createCapFileStorage } from "../src/capability";
import { resetStorageAdapter } from "../src/storage-registry";

describe("cap-file-storage capability", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cap-file-storage-cap-"));
    resetStorageAdapter();
  });

  afterEach(async () => {
    resetStorageAdapter();
    await rm(root, { recursive: true, force: true });
  });

  it("has correct metadata", () => {
    const cap = createCapFileStorage({
      adapter: new LocalStorageAdapter({ rootDir: root }),
    });
    expect(cap.name).toBe("cap-file-storage");
    expect(cap.type).toBe("standard");
    expect(cap.category).toBe("system");
    expect(cap.version).toBe("0.0.1");
    expect(cap.group).toBe("file-storage");
  });

  it("registers the file entity", () => {
    const cap = createCapFileStorage({
      adapter: new LocalStorageAdapter({ rootDir: root }),
    });
    const names = cap.entities?.map((e) => e.name) ?? [];
    expect(names).toEqual(["file"]);
  });

  it("registers the 3 actions with verb_noun naming", () => {
    const cap = createCapFileStorage({
      adapter: new LocalStorageAdapter({ rootDir: root }),
    });
    const names = cap.actions?.map((a) => a.name) ?? [];
    expect(names).toContain("upload_file");
    expect(names).toContain("download_file");
    expect(names).toContain("delete_file");
    expect(names).toHaveLength(3);
  });

  it("exposes the adapter as a 'storage' service", () => {
    const adapter = new LocalStorageAdapter({ rootDir: root });
    const cap = createCapFileStorage({ adapter });
    const storageService = cap.extensions?.services?.find((s) => s.name === "storage");
    expect(storageService).toBeDefined();
    expect(storageService?.factory()).toBe(adapter);
  });

  it("declares system permissions with dot notation", () => {
    const cap = createCapFileStorage({
      adapter: new LocalStorageAdapter({ rootDir: root }),
    });
    expect(cap.systemPermissions).toContain("database.read");
    expect(cap.systemPermissions).toContain("database.write");
    expect(cap.systemPermissions).toContain("event.emit");
  });

  it("falls back to a LocalStorageAdapter when no adapter is supplied", () => {
    const cap = createCapFileStorage({ rootDir: root });
    expect(cap.adapter).toBeInstanceOf(LocalStorageAdapter);
    expect(cap.adapter.name).toBe("local");
  });
});
