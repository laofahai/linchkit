import { describe, expect, test } from "bun:test";
import { buildCsv } from "../src/components/auto-list/csv-export";

describe("buildCsv", () => {
  const fields = [
    { field: "name", label: "Name" },
    { field: "age", label: "Age" },
    { field: "email", label: "Email" },
  ];

  test("generates header row from field labels", () => {
    const csv = buildCsv({ fields, data: [], schemaName: "test" });
    expect(csv).toBe("Name,Age,Email");
  });

  test("generates data rows", () => {
    const data = [
      { name: "Alice", age: 30, email: "alice@example.com" },
      { name: "Bob", age: 25, email: "bob@example.com" },
    ];
    const csv = buildCsv({ fields, data, schemaName: "test" });
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("Name,Age,Email");
    expect(lines[1]).toBe("Alice,30,alice@example.com");
    expect(lines[2]).toBe("Bob,25,bob@example.com");
  });

  test("handles null and undefined values", () => {
    const data = [{ name: null, age: undefined, email: "test@test.com" }];
    const csv = buildCsv({ fields, data, schemaName: "test" });
    const lines = csv.split("\r\n");
    expect(lines[1]).toBe(",,test@test.com");
  });

  test("escapes commas in values", () => {
    const data = [{ name: "Doe, Jane", age: 28, email: "jane@test.com" }];
    const csv = buildCsv({ fields, data, schemaName: "test" });
    const lines = csv.split("\r\n");
    expect(lines[1]).toBe('"Doe, Jane",28,jane@test.com');
  });

  test("escapes double quotes in values", () => {
    const data = [{ name: 'He said "hi"', age: 20, email: "x@y.com" }];
    const csv = buildCsv({ fields, data, schemaName: "test" });
    const lines = csv.split("\r\n");
    expect(lines[1]).toBe('"He said ""hi""",20,x@y.com');
  });

  test("escapes newlines in values", () => {
    const data = [{ name: "Line1\nLine2", age: 30, email: "a@b.com" }];
    const csv = buildCsv({ fields, data, schemaName: "test" });
    const lines = csv.split("\r\n");
    // The value with newline should be quoted
    expect(lines[1]).toContain('"Line1\nLine2"');
  });

  test("serializes object values as JSON", () => {
    const data = [{ name: "Test", age: 30, email: { primary: "a@b.com" } }];
    const csv = buildCsv({ fields, data, schemaName: "test" });
    const lines = csv.split("\r\n");
    // JSON contains commas/quotes, so it should be escaped
    expect(lines[1]).toContain("Test,30,");
    expect(lines[1]).toContain("primary");
  });

  test("serializes array values as JSON", () => {
    const data = [{ name: "Test", age: 30, email: ["a@b.com", "c@d.com"] }];
    const csv = buildCsv({ fields, data, schemaName: "test" });
    const lines = csv.split("\r\n");
    expect(lines[1]).toContain("Test,30,");
  });

  test("uses field name as fallback when label is missing", () => {
    const noLabelFields = [
      { field: "name" },
      { field: "status" },
    ];
    const csv = buildCsv({ fields: noLabelFields, data: [], schemaName: "test" });
    expect(csv).toBe("name,status");
  });

  test("uses resolveLabel when provided", () => {
    const resolver = (label: string | undefined, fallback: string) =>
      label ? `[${label}]` : fallback.toUpperCase();
    const csv = buildCsv({ fields, data: [], schemaName: "test", resolveLabel: resolver });
    expect(csv).toBe("[Name],[Age],[Email]");
  });

  test("escapes commas in header labels", () => {
    const commaFields = [{ field: "name", label: "Last, First" }];
    const csv = buildCsv({ fields: commaFields, data: [], schemaName: "test" });
    expect(csv).toBe('"Last, First"');
  });
});
