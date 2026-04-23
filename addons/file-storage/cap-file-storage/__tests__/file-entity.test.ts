import { describe, expect, it } from "bun:test";
import { fileEntity } from "../src/entities/file";

describe("file entity", () => {
  it("uses snake_case singular noun", () => {
    expect(fileEntity.name).toBe("file");
  });

  it("has the required metadata fields", () => {
    const fields = fileEntity.fields;
    expect(fields.name?.type).toBe("string");
    expect(fields.name?.required).toBe(true);
    expect(fields.size?.type).toBe("number");
    expect(fields.size?.required).toBe(true);
    expect(fields.mime?.type).toBe("string");
    expect(fields.mime?.required).toBe(true);
    expect(fields.path?.type).toBe("string");
    expect(fields.path?.required).toBe(true);
    expect(fields.adapter?.type).toBe("string");
    expect(fields.adapter?.required).toBe(true);
    expect(fields.uploaded_by?.type).toBe("string");
    expect(fields.uploaded_by?.required).toBe(true);
  });

  it("does not redeclare system-managed fields", () => {
    // created_at, updated_at, id, tenant_id, created_by, updated_by, _version
    // are injected by the core runtime and must NOT appear in user fields.
    const forbidden = [
      "id",
      "tenant_id",
      "created_at",
      "updated_at",
      "created_by",
      "updated_by",
      "_version",
    ];
    for (const key of forbidden) {
      expect(fileEntity.fields[key]).toBeUndefined();
    }
  });

  it("declares sensible presentation metadata", () => {
    expect(fileEntity.presentation?.titleField).toBe("name");
    expect(fileEntity.presentation?.icon).toBe("file");
  });

  it("constrains size to be non-negative", () => {
    const size = fileEntity.fields.size;
    expect(size?.type).toBe("number");
    if (size?.type === "number") {
      expect(size.min).toBe(0);
    }
  });
});
