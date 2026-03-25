import { describe, expect, it } from "bun:test";
import {
  CSVImportSource,
  DataImporter,
  JSONImportSource,
  MigrationResumeTracker,
  MigrationRunner,
  SchemaMapper,
} from "../src/migration";
import type { SchemaDefinition } from "../src/types/schema";

// ── Test schema ─────────────────────────────────────────────

const employeeSchema: SchemaDefinition = {
  name: "employee",
  label: "Employee",
  fields: {
    name: { type: "string", required: true, label: "Name" },
    email: { type: "string", required: true, format: "email", label: "Email" },
    age: { type: "number", label: "Age" },
    active: { type: "boolean", label: "Active" },
    department: {
      type: "enum",
      label: "Department",
      options: [
        { value: "engineering", label: "Engineering" },
        { value: "sales", label: "Sales" },
        { value: "hr", label: "HR" },
      ],
    },
    hire_date: { type: "date", label: "Hire Date" },
  },
};

// ── SchemaMapper ────────────────────────────────────────────

describe("SchemaMapper", () => {
  it("maps fields from source to target", () => {
    const mapper = new SchemaMapper({
      targetSchema: employeeSchema,
      mappings: [
        { source: "full_name", target: "name" },
        { source: "email_addr", target: "email" },
        { source: "years", target: "age", transform: { type: "toNumber" } },
      ],
    });

    const result = mapper.mapRecord({
      full_name: "Alice",
      email_addr: "alice@example.com",
      years: "30",
    });

    expect(result.data).toEqual({
      name: "Alice",
      email: "alice@example.com",
      age: 30,
    });
    expect(result.errors).toHaveLength(0);
  });

  it("supports nested source fields via dot-notation", () => {
    const mapper = new SchemaMapper({
      targetSchema: employeeSchema,
      mappings: [
        { source: "person.name", target: "name" },
        { source: "person.contact.email", target: "email" },
      ],
    });

    const result = mapper.mapRecord({
      person: { name: "Bob", contact: { email: "bob@example.com" } },
    });

    expect(result.data.name).toBe("Bob");
    expect(result.data.email).toBe("bob@example.com");
  });

  it("applies trim transform", () => {
    const mapper = new SchemaMapper({
      targetSchema: employeeSchema,
      mappings: [{ source: "name", target: "name", transform: { type: "trim" } }],
    });

    const result = mapper.mapRecord({ name: "  Alice  " });
    expect(result.data.name).toBe("Alice");
  });

  it("applies lowercase and uppercase transforms", () => {
    const mapper = new SchemaMapper({
      targetSchema: employeeSchema,
      mappings: [
        { source: "name", target: "name", transform: { type: "uppercase" } },
        { source: "email", target: "email", transform: { type: "lowercase" } },
      ],
    });

    const result = mapper.mapRecord({ name: "Alice", email: "ALICE@EXAMPLE.COM" });
    expect(result.data.name).toBe("ALICE");
    expect(result.data.email).toBe("alice@example.com");
  });

  it("applies toBoolean transform with custom truthy values", () => {
    const mapper = new SchemaMapper({
      targetSchema: employeeSchema,
      mappings: [
        {
          source: "is_active",
          target: "active",
          transform: { type: "toBoolean", truthy: ["yes", "active", "1"] },
        },
      ],
    });

    expect(mapper.mapRecord({ is_active: "yes" }).data.active).toBe(true);
    expect(mapper.mapRecord({ is_active: "no" }).data.active).toBe(false);
    expect(mapper.mapRecord({ is_active: "active" }).data.active).toBe(true);
  });

  it("applies toDate transform", () => {
    const mapper = new SchemaMapper({
      targetSchema: employeeSchema,
      mappings: [{ source: "hired", target: "hire_date", transform: { type: "toDate" } }],
    });

    const result = mapper.mapRecord({ hired: "2024-01-15" });
    expect(result.data.hire_date).toBeInstanceOf(Date);
    expect((result.data.hire_date as Date).toISOString()).toContain("2024-01-15");
  });

  it("applies enumMap transform", () => {
    const mapper = new SchemaMapper({
      targetSchema: employeeSchema,
      mappings: [
        {
          source: "dept",
          target: "department",
          transform: { type: "enumMap", mapping: { ENG: "engineering", SALES: "sales", HR: "hr" } },
        },
      ],
    });

    expect(mapper.mapRecord({ dept: "ENG" }).data.department).toBe("engineering");
    expect(mapper.mapRecord({ dept: "UNKNOWN" }).data.department).toBeNull();
  });

  it("applies default transform", () => {
    const mapper = new SchemaMapper({
      targetSchema: employeeSchema,
      mappings: [
        {
          source: "dept",
          target: "department",
          transform: { type: "default", value: "engineering" },
        },
      ],
    });

    expect(mapper.mapRecord({ dept: "" }).data.department).toBe("engineering");
    expect(mapper.mapRecord({ dept: null }).data.department).toBe("engineering");
    expect(mapper.mapRecord({ dept: "sales" }).data.department).toBe("sales");
  });

  it("applies a pipeline of transforms", () => {
    const mapper = new SchemaMapper({
      targetSchema: employeeSchema,
      mappings: [
        {
          source: "name",
          target: "name",
          transform: [{ type: "trim" }, { type: "uppercase" }],
        },
      ],
    });

    const result = mapper.mapRecord({ name: "  alice  " });
    expect(result.data.name).toBe("ALICE");
  });

  it("supports custom transform functions", () => {
    const mapper = new SchemaMapper({
      targetSchema: employeeSchema,
      mappings: [
        {
          source: "name",
          target: "name",
          transform: (v) => `PREFIX_${v}`,
        },
      ],
    });

    const result = mapper.mapRecord({ name: "Alice" });
    expect(result.data.name).toBe("PREFIX_Alice");
  });

  it("validates mappings against target schema", () => {
    const mapper = new SchemaMapper({
      targetSchema: employeeSchema,
      mappings: [
        { source: "x", target: "name" },
        { source: "y", target: "nonexistent_field" },
      ],
    });

    const result = mapper.validate();
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("nonexistent_field");
  });

  it("warns about required fields without mappings", () => {
    const mapper = new SchemaMapper({
      targetSchema: employeeSchema,
      mappings: [{ source: "x", target: "name" }],
    });

    const result = mapper.validate();
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("email"))).toBe(true);
  });

  it("maps multiple records", () => {
    const mapper = new SchemaMapper({
      targetSchema: employeeSchema,
      mappings: [{ source: "n", target: "name" }],
    });

    const results = mapper.mapRecords([{ n: "A" }, { n: "B" }]);
    expect(results).toHaveLength(2);
    expect(results[0].data.name).toBe("A");
    expect(results[1].data.name).toBe("B");
  });
});

// ── CSVImportSource ─────────────────────────────────────────

describe("CSVImportSource", () => {
  it("parses CSV content with headers", async () => {
    const source = new CSVImportSource({
      content: "name,email,age\nAlice,alice@ex.com,30\nBob,bob@ex.com,25",
    });

    expect(await source.totalCount()).toBe(2);
    const batch = await source.readBatch(10, 0);
    expect(batch).toHaveLength(2);
    expect(batch[0]).toEqual({ name: "Alice", email: "alice@ex.com", age: "30" });
    expect(batch[1]).toEqual({ name: "Bob", email: "bob@ex.com", age: "25" });
  });

  it("handles quoted fields with commas", async () => {
    const source = new CSVImportSource({
      content: 'name,note\n"Smith, John","says ""hello"""',
    });

    const batch = await source.readBatch(10, 0);
    expect(batch[0].name).toBe("Smith, John");
    expect(batch[0].note).toBe('says "hello"');
  });

  it("supports custom delimiter", async () => {
    const source = new CSVImportSource({
      content: "name\temail\nAlice\talice@ex.com",
      delimiter: "\t",
    });

    const batch = await source.readBatch(10, 0);
    expect(batch[0].name).toBe("Alice");
  });

  it("supports batched reading with offset", async () => {
    const source = new CSVImportSource({
      content: "id\n1\n2\n3\n4\n5",
    });

    const batch1 = await source.readBatch(2, 0);
    expect(batch1).toHaveLength(2);
    expect(batch1[0].id).toBe("1");

    const batch2 = await source.readBatch(2, 2);
    expect(batch2).toHaveLength(2);
    expect(batch2[0].id).toBe("3");

    const batch3 = await source.readBatch(2, 4);
    expect(batch3).toHaveLength(1);
    expect(batch3[0].id).toBe("5");
  });

  it("handles empty CSV", async () => {
    const source = new CSVImportSource({ content: "" });
    expect(await source.totalCount()).toBe(0);
    expect(await source.readBatch(10, 0)).toEqual([]);
  });
});

// ── JSONImportSource ────────────────────────────────────────

describe("JSONImportSource", () => {
  it("reads from an array of records", async () => {
    const source = new JSONImportSource({
      data: [
        { name: "Alice", age: 30 },
        { name: "Bob", age: 25 },
      ],
    });

    expect(await source.totalCount()).toBe(2);
    const batch = await source.readBatch(10, 0);
    expect(batch).toHaveLength(2);
  });

  it("wraps a single record into an array", async () => {
    const source = new JSONImportSource({
      data: { name: "Alice" },
    });

    expect(await source.totalCount()).toBe(1);
    const batch = await source.readBatch(10, 0);
    expect(batch[0].name).toBe("Alice");
  });

  it("supports batched reading", async () => {
    const data = Array.from({ length: 10 }, (_, i) => ({ id: i }));
    const source = new JSONImportSource({ data });

    const batch = await source.readBatch(3, 6);
    expect(batch).toHaveLength(3);
    expect(batch[0].id).toBe(6);
  });
});

// ── DataImporter ────────────────────────────────────────────

describe("DataImporter", () => {
  it("imports records from source through mapper to writer", async () => {
    const written: Record<string, unknown>[] = [];

    const source = new JSONImportSource({
      data: [
        { full_name: "Alice", email_addr: "alice@ex.com" },
        { full_name: "Bob", email_addr: "bob@ex.com" },
      ],
    });

    const mapper = new SchemaMapper({
      targetSchema: employeeSchema,
      mappings: [
        { source: "full_name", target: "name" },
        { source: "email_addr", target: "email" },
      ],
    });

    const importer = new DataImporter({
      source,
      mapper,
      writer: async (record) => {
        written.push(record);
      },
    });

    const result = await importer.run();
    expect(result.totalProcessed).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(written).toHaveLength(2);
    expect(written[0].name).toBe("Alice");
  });

  it("skips errors in skip mode", async () => {
    const written: Record<string, unknown>[] = [];
    let callCount = 0;

    const source = new JSONImportSource({
      data: [{ name: "Alice" }, { name: "Bob" }, { name: "Charlie" }],
    });

    const mapper = new SchemaMapper({
      targetSchema: employeeSchema,
      mappings: [{ source: "name", target: "name" }],
    });

    const importer = new DataImporter({
      source,
      mapper,
      writer: async (record) => {
        callCount++;
        if (callCount === 2) throw new Error("DB write failed");
        written.push(record);
      },
      errorMode: "skip",
    });

    const result = await importer.run();
    expect(result.totalProcessed).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].index).toBe(1);
    expect(result.errors[0].message).toContain("DB write failed");
  });

  it("stops on first error in fail-fast mode", async () => {
    let callCount = 0;

    const source = new JSONImportSource({
      data: [{ name: "Alice" }, { name: "Bob" }, { name: "Charlie" }],
    });

    const mapper = new SchemaMapper({
      targetSchema: employeeSchema,
      mappings: [{ source: "name", target: "name" }],
    });

    const importer = new DataImporter({
      source,
      mapper,
      writer: async () => {
        callCount++;
        if (callCount === 2) throw new Error("fail");
      },
      errorMode: "fail-fast",
    });

    const result = await importer.run();
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    // Should not have processed the third record
    expect(result.totalProcessed).toBe(2);
  });

  it("reports progress via callback", async () => {
    const progressReports: Array<{ processed: number; succeeded: number }> = [];

    const source = new JSONImportSource({
      data: [{ name: "A" }, { name: "B" }, { name: "C" }],
    });

    const mapper = new SchemaMapper({
      targetSchema: employeeSchema,
      mappings: [{ source: "name", target: "name" }],
    });

    const importer = new DataImporter({
      source,
      mapper,
      writer: async () => {},
      batchSize: 2,
      onProgress: (p) => progressReports.push({ processed: p.processed, succeeded: p.succeeded }),
    });

    await importer.run();
    // batch of 2 + batch of 1 = 2 progress calls
    expect(progressReports.length).toBeGreaterThanOrEqual(2);
    expect(progressReports[progressReports.length - 1].processed).toBe(3);
  });

  it("records duration", async () => {
    const source = new JSONImportSource({ data: [{ name: "A" }] });
    const mapper = new SchemaMapper({
      targetSchema: employeeSchema,
      mappings: [{ source: "name", target: "name" }],
    });

    const importer = new DataImporter({
      source,
      mapper,
      writer: async () => {},
    });

    const result = await importer.run();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ── MigrationRunner ─────────────────────────────────────────

describe("MigrationRunner", () => {
  it("runs a full migration plan", async () => {
    const written: Record<string, unknown>[] = [];

    const runner = new MigrationRunner();
    const result = await runner.run({
      name: "test-migration",
      source: new JSONImportSource({
        data: [
          { full_name: "Alice", email_addr: "a@ex.com" },
          { full_name: "Bob", email_addr: "b@ex.com" },
        ],
      }),
      targetSchema: employeeSchema,
      mappings: [
        { source: "full_name", target: "name" },
        { source: "email_addr", target: "email" },
      ],
      writer: async (record) => {
        written.push(record);
      },
    });

    expect(result.planName).toBe("test-migration");
    expect(result.dryRun).toBe(false);
    expect(result.succeeded).toBe(2);
    expect(written).toHaveLength(2);
  });

  it("supports dry-run mode (no writes)", async () => {
    const written: Record<string, unknown>[] = [];

    const runner = new MigrationRunner();
    const result = await runner.run(
      {
        name: "dry-test",
        source: new JSONImportSource({ data: [{ n: "Alice" }] }),
        targetSchema: employeeSchema,
        mappings: [{ source: "n", target: "name" }],
        writer: async (record) => {
          written.push(record);
        },
      },
      { dryRun: true },
    );

    expect(result.dryRun).toBe(true);
    expect(result.succeeded).toBe(1);
    // Writer should NOT have been called
    expect(written).toHaveLength(0);
  });

  it("returns validation errors without running import", async () => {
    const runner = new MigrationRunner();
    const result = await runner.run({
      name: "invalid-migration",
      source: new JSONImportSource({ data: [{ x: 1 }] }),
      targetSchema: employeeSchema,
      mappings: [{ source: "x", target: "nonexistent_field" }],
      writer: async () => {},
    });

    expect(result.validationErrors.length).toBeGreaterThan(0);
    expect(result.totalProcessed).toBe(0);
  });

  it("supports resume via offset", async () => {
    const written: Record<string, unknown>[] = [];
    const data = [{ n: "A" }, { n: "B" }, { n: "C" }, { n: "D" }];

    const runner = new MigrationRunner();
    const result = await runner.run(
      {
        name: "resume-test",
        source: new JSONImportSource({ data }),
        targetSchema: employeeSchema,
        mappings: [{ source: "n", target: "name" }],
        writer: async (record) => {
          written.push(record);
        },
      },
      { resumeOffset: 2 },
    );

    // Should skip first 2 records
    expect(result.succeeded).toBe(2);
    expect(written).toHaveLength(2);
    expect(written[0].name).toBe("C");
    expect(written[1].name).toBe("D");
  });

  it("tracks resume offset across runs", async () => {
    const tracker = new MigrationResumeTracker();
    const runner = new MigrationRunner({ resumeTracker: tracker });

    const plan = {
      name: "tracked-migration",
      source: new JSONImportSource({ data: [{ n: "A" }, { n: "B" }] }),
      targetSchema: employeeSchema,
      mappings: [{ source: "n", target: "name" }] as const,
      writer: async () => {},
    };

    await runner.run(plan);
    expect(tracker.getOffset("tracked-migration")).toBe(2);

    // Simulate a second run — source has new data, offset should continue
    tracker.clear("tracked-migration");
    expect(tracker.getOffset("tracked-migration")).toBe(0);
  });

  it("reports progress with plan name", async () => {
    const reports: Array<{ planName: string; processed: number }> = [];

    const runner = new MigrationRunner();
    await runner.run(
      {
        name: "progress-test",
        source: new JSONImportSource({ data: [{ n: "A" }, { n: "B" }] }),
        targetSchema: employeeSchema,
        mappings: [{ source: "n", target: "name" }],
        writer: async () => {},
        batchSize: 1,
      },
      {
        onProgress: (info) => reports.push({ planName: info.planName, processed: info.processed }),
      },
    );

    expect(reports.length).toBeGreaterThanOrEqual(1);
    expect(reports[0].planName).toBe("progress-test");
  });
});

// ── End-to-end: CSV → LinchKit ──────────────────────────────

describe("End-to-end: CSV migration", () => {
  it("imports CSV data with transforms into target schema", async () => {
    const written: Record<string, unknown>[] = [];

    const csvContent = [
      "full_name,email_addr,years_old,is_active,dept_code,hire_date",
      "  Alice Smith ,alice@example.com,28,yes,ENG,2023-06-15",
      "  Bob Jones ,bob@example.com,35,no,SALES,2022-01-10",
    ].join("\n");

    const runner = new MigrationRunner();
    const result = await runner.run({
      name: "csv-e2e",
      source: new CSVImportSource({ content: csvContent }),
      targetSchema: employeeSchema,
      mappings: [
        { source: "full_name", target: "name", transform: { type: "trim" } },
        { source: "email_addr", target: "email", transform: { type: "lowercase" } },
        { source: "years_old", target: "age", transform: { type: "toNumber" } },
        { source: "is_active", target: "active", transform: { type: "toBoolean" } },
        {
          source: "dept_code",
          target: "department",
          transform: { type: "enumMap", mapping: { ENG: "engineering", SALES: "sales", HR: "hr" } },
        },
        { source: "hire_date", target: "hire_date", transform: { type: "toDate" } },
      ],
      writer: async (record) => {
        written.push(record);
      },
    });

    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);

    expect(written[0].name).toBe("Alice Smith");
    expect(written[0].email).toBe("alice@example.com");
    expect(written[0].age).toBe(28);
    expect(written[0].active).toBe(true);
    expect(written[0].department).toBe("engineering");
    expect(written[0].hire_date).toBeInstanceOf(Date);

    expect(written[1].name).toBe("Bob Jones");
    expect(written[1].active).toBe(false);
    expect(written[1].department).toBe("sales");
  });
});
