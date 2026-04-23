import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorageAdapter } from "../src/adapters/local-adapter";

describe("LocalStorageAdapter", () => {
  let root: string;
  let adapter: LocalStorageAdapter;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cap-file-storage-"));
    adapter = new LocalStorageAdapter({ rootDir: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("exposes a default adapter name of 'local'", () => {
    expect(adapter.name).toBe("local");
  });

  it("honors a custom adapter name", () => {
    const named = new LocalStorageAdapter({ rootDir: root, name: "custom" });
    expect(named.name).toBe("custom");
  });

  it("rejects construction without rootDir", () => {
    // biome-ignore lint/suspicious/noExplicitAny: intentional invalid input for test
    expect(() => new LocalStorageAdapter({} as any)).toThrow(/rootDir/);
  });

  it("write() persists payload, returns size + sha256 checksum", async () => {
    const data = new TextEncoder().encode("hello, file storage");
    const result = await adapter.write({ path: "greeting.txt", data, mime: "text/plain" });

    expect(result.path).toBe("greeting.txt");
    expect(result.size).toBe(data.byteLength);
    // sha256("hello, file storage")
    expect(result.checksum).toBe(
      "7de5f25d87840d5a6214a0ec7334b26b07a81c95d9f4789155dc88b65e14519a",
    );
  });

  it("read() round-trips the exact bytes", async () => {
    const data = new Uint8Array([0, 1, 2, 3, 4, 5, 255]);
    await adapter.write({ path: "nested/dir/bin.dat", data });
    const out = await adapter.read("nested/dir/bin.dat");
    expect(out.byteLength).toBe(data.byteLength);
    expect(Array.from(out)).toEqual(Array.from(data));
  });

  it("exists() reflects write and delete", async () => {
    expect(await adapter.exists("a.txt")).toBe(false);
    await adapter.write({ path: "a.txt", data: new Uint8Array([1]) });
    expect(await adapter.exists("a.txt")).toBe(true);
    await adapter.delete("a.txt");
    expect(await adapter.exists("a.txt")).toBe(false);
  });

  it("delete() is idempotent for missing files", async () => {
    await expect(adapter.delete("does-not-exist")).resolves.toBeUndefined();
  });

  it("read() throws for missing file", async () => {
    await expect(adapter.read("missing")).rejects.toThrow();
  });

  it("rejects absolute paths (path-traversal guard)", async () => {
    await expect(adapter.write({ path: "/etc/passwd", data: new Uint8Array() })).rejects.toThrow(
      /relative/,
    );
  });

  it("rejects parent-directory escapes", async () => {
    await expect(adapter.write({ path: "../escape.txt", data: new Uint8Array() })).rejects.toThrow(
      /escapes/,
    );
  });

  it("rejects null bytes in path", async () => {
    await expect(adapter.write({ path: "bad\0path", data: new Uint8Array() })).rejects.toThrow(
      /null bytes/,
    );
  });

  it("rejects non-Uint8Array data", async () => {
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: intentional invalid input for test
      adapter.write({ path: "x.txt", data: "not bytes" as any }),
    ).rejects.toThrow(/Uint8Array/);
  });
});
