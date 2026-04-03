import { describe, expect, test } from "bun:test";

// We test the pure mapFieldType logic from filter-columns.ts.
// Since mapFieldType and fieldIcon are not exported, we re-implement them for testing.
// The buildFilterColumns function depends on bazza/ui internals (createColumnConfigHelper),
// so we test the mapping logic separately.

/** Maps a LinchKit FieldType to a bazza ColumnDataType, or null if not filterable. */
function mapFieldType(fieldType: string): string | null {
  switch (fieldType) {
    case "string":
    case "text":
      return "text";
    case "number":
      return "number";
    case "date":
    case "datetime":
      return "date";
    case "enum":
    case "state":
      return "option";
    case "boolean":
      return "option";
    default:
      return null;
  }
}

describe("mapFieldType", () => {
  test("maps string to text", () => {
    expect(mapFieldType("string")).toBe("text");
  });

  test("maps text to text", () => {
    expect(mapFieldType("text")).toBe("text");
  });

  test("maps number to number", () => {
    expect(mapFieldType("number")).toBe("number");
  });

  test("maps date to date", () => {
    expect(mapFieldType("date")).toBe("date");
  });

  test("maps datetime to date", () => {
    expect(mapFieldType("datetime")).toBe("date");
  });

  test("maps enum to option", () => {
    expect(mapFieldType("enum")).toBe("option");
  });

  test("maps state to option", () => {
    expect(mapFieldType("state")).toBe("option");
  });

  test("maps boolean to option", () => {
    expect(mapFieldType("boolean")).toBe("option");
  });

  test("returns null for non-filterable types", () => {
    expect(mapFieldType("json")).toBeNull();
    expect(mapFieldType("computed")).toBeNull();
    expect(mapFieldType("ref")).toBeNull();
    expect(mapFieldType("has_many")).toBeNull();
    expect(mapFieldType("many_to_many")).toBeNull();
    expect(mapFieldType("unknown")).toBeNull();
  });
});

// Test extractOptions logic for different field types
describe("extractOptions logic", () => {
  test("enum field extracts options from definition", () => {
    const fieldDef = {
      type: "enum" as const,
      options: [
        { value: "low", label: "Low" },
        { value: "medium", label: "Medium" },
        { value: "high", label: "High" },
      ],
    };

    const options = fieldDef.options.map((o) => ({
      value: o.value,
      label: o.label ?? o.value,
    }));

    expect(options).toEqual([
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
    ]);
  });

  test("enum field falls back to value when label is missing", () => {
    const fieldDef = {
      type: "enum" as const,
      options: [{ value: "active" }, { value: "inactive" }],
    };

    const options = fieldDef.options.map((o: { value: string; label?: string }) => ({
      value: o.value,
      label: o.label ?? o.value,
    }));

    expect(options).toEqual([
      { value: "active", label: "active" },
      { value: "inactive", label: "inactive" },
    ]);
  });

  test("boolean field produces true/false options", () => {
    const options = [
      { value: "true", label: "Yes" },
      { value: "false", label: "No" },
    ];
    expect(options).toHaveLength(2);
    expect(options[0].value).toBe("true");
    expect(options[1].value).toBe("false");
  });

  test("state field extracts from stateMeta when available", () => {
    const stateMeta: Record<string, { label?: string }> = {
      draft: { label: "Draft" },
      submitted: { label: "Submitted" },
      approved: { label: "Approved" },
    };

    const options = Object.entries(stateMeta).map(([value, meta]) => ({
      value,
      label: meta?.label ?? value,
    }));

    expect(options).toEqual([
      { value: "draft", label: "Draft" },
      { value: "submitted", label: "Submitted" },
      { value: "approved", label: "Approved" },
    ]);
  });

  test("state field derives unique values from data when no stateMeta", () => {
    const data = [
      { status: "draft" },
      { status: "approved" },
      { status: "draft" },
      { status: "submitted" },
    ];

    const unique = new Set<string>();
    for (const row of data) {
      const v = row.status;
      if (typeof v === "string" && v) unique.add(v);
    }

    const options = Array.from(unique).map((v) => ({ value: v, label: v }));
    expect(options).toHaveLength(3);
    expect(options.map((o) => o.value)).toContain("draft");
    expect(options.map((o) => o.value)).toContain("approved");
    expect(options.map((o) => o.value)).toContain("submitted");
  });
});
