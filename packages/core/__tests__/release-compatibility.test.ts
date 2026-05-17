import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateReleaseType,
  analyzeFile,
  analyzeMigrationSql,
  buildResult,
  checkReleaseCompatibility,
  classifyStatement,
  splitStatements,
} from "../src/migration/release-compatibility";

// ── splitStatements ───────────────────────────────────────────────────────────

describe("splitStatements", () => {
  test("splits on Drizzle statement-breakpoint marker", () => {
    const sql = `CREATE TABLE "foo" ();
--> statement-breakpoint
ALTER TABLE "foo" ADD COLUMN "bar" text;`;
    const parts = splitStatements(sql);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain("CREATE TABLE");
    expect(parts[1]).toContain("ADD COLUMN");
  });

  test("non-Drizzle files treated as single block (no semicolon split)", () => {
    const sql = `CREATE TABLE "a" (); ALTER TABLE "a" ADD COLUMN "x" text;`;
    const parts = splitStatements(sql);
    expect(parts).toHaveLength(1);
  });

  test("filters empty strings and comment-only lines", () => {
    const sql = `--> statement-breakpoint\n-- just a comment\n\nALTER TABLE "t" ADD COLUMN "c" text;`;
    const parts = splitStatements(sql);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toContain("ADD COLUMN");
  });
});

// ── classifyStatement ─────────────────────────────────────────────────────────

describe("classifyStatement", () => {
  test("CREATE TABLE → expand", () => {
    const r = classifyStatement(`CREATE TABLE "_linchkit"."foo" ( "id" uuid PRIMARY KEY );`);
    expect(r.type).toBe("expand");
  });

  test("CREATE TYPE AS ENUM → expand", () => {
    const r = classifyStatement(`CREATE TYPE "_linchkit"."status" AS ENUM('active', 'inactive');`);
    expect(r.type).toBe("expand");
  });

  test("CREATE INDEX → expand", () => {
    const r = classifyStatement(`CREATE UNIQUE INDEX "idx_foo" ON "foo" USING btree ("id");`);
    expect(r.type).toBe("expand");
  });

  test("ADD COLUMN nullable → expand", () => {
    const r = classifyStatement(`ALTER TABLE "_linchkit"."events" ADD COLUMN "meta" jsonb;`);
    expect(r.type).toBe("expand");
  });

  test("ADD COLUMN with DEFAULT → expand", () => {
    const r = classifyStatement(
      `ALTER TABLE "t" ADD COLUMN "active" boolean NOT NULL DEFAULT true;`,
    );
    expect(r.type).toBe("expand");
  });

  test("ADD COLUMN NOT NULL without DEFAULT → breaking", () => {
    const r = classifyStatement(`ALTER TABLE "t" ADD COLUMN "required_field" text NOT NULL;`);
    expect(r.type).toBe("breaking");
  });

  test("DROP COLUMN → contract", () => {
    const r = classifyStatement(`ALTER TABLE "t" DROP COLUMN "old_field";`);
    expect(r.type).toBe("contract");
  });

  test("RENAME COLUMN → contract", () => {
    const r = classifyStatement(
      `ALTER TABLE "_linchkit"."approvals" RENAME COLUMN "metadata" TO "actors_snapshot";`,
    );
    expect(r.type).toBe("contract");
  });

  test("ALTER COLUMN TYPE → breaking", () => {
    const r = classifyStatement(
      `ALTER TABLE "t" ALTER COLUMN "amount" TYPE numeric USING amount::numeric;`,
    );
    expect(r.type).toBe("breaking");
  });

  test("ALTER COLUMN SET NOT NULL → contract", () => {
    const r = classifyStatement(`ALTER TABLE "t" ALTER COLUMN "name" SET NOT NULL;`);
    expect(r.type).toBe("contract");
  });

  test("ALTER COLUMN DROP NOT NULL → expand", () => {
    const r = classifyStatement(`ALTER TABLE "t" ALTER COLUMN "name" DROP NOT NULL;`);
    expect(r.type).toBe("expand");
  });

  test("DROP TABLE → contract", () => {
    const r = classifyStatement(`DROP TABLE "old_table";`);
    expect(r.type).toBe("contract");
  });

  test("DROP TYPE → contract", () => {
    const r = classifyStatement(`DROP TYPE "_linchkit"."old_status";`);
    expect(r.type).toBe("contract");
  });

  test("DROP INDEX → safe", () => {
    const r = classifyStatement(`DROP INDEX "idx_old";`);
    expect(r.type).toBe("safe");
  });

  test("RENAME TABLE → contract", () => {
    const r = classifyStatement(`ALTER TABLE "old_name" RENAME TO "new_name";`);
    expect(r.type).toBe("contract");
  });

  test("unknown statement (non-ALTER/DROP) → safe", () => {
    const r = classifyStatement(`COMMENT ON TABLE "t" IS 'Some comment';`);
    expect(r.type).toBe("safe");
  });

  test("unrecognised ALTER → contract (conservative fallback)", () => {
    const r = classifyStatement(`ALTER TABLE "t" ADD CONSTRAINT "pk" PRIMARY KEY ("id");`);
    expect(r.type).toBe("contract");
  });

  test("TRUNCATE TABLE → contract (conservative fallback)", () => {
    const r = classifyStatement(`TRUNCATE TABLE "t";`);
    expect(r.type).toBe("contract");
  });
});

// ── aggregateReleaseType ──────────────────────────────────────────────────────

describe("aggregateReleaseType", () => {
  test("empty → safe", () => {
    expect(aggregateReleaseType([])).toBe("safe");
  });

  test("all safe → safe", () => {
    expect(aggregateReleaseType(["safe", "safe"])).toBe("safe");
  });

  test("safe + expand → expand", () => {
    expect(aggregateReleaseType(["safe", "expand"])).toBe("expand");
  });

  test("expand + contract → contract", () => {
    expect(aggregateReleaseType(["expand", "contract"])).toBe("contract");
  });

  test("contract + breaking → breaking", () => {
    expect(aggregateReleaseType(["contract", "breaking"])).toBe("breaking");
  });

  test("one breaking wins regardless of order", () => {
    expect(aggregateReleaseType(["safe", "expand", "breaking", "contract"])).toBe("breaking");
  });
});

// ── buildResult ───────────────────────────────────────────────────────────────

describe("buildResult", () => {
  test("safe: no blockers, traffic_only rollback", () => {
    const r = buildResult("safe");
    expect(r.releaseType).toBe("safe");
    expect(r.oldVersionCanRead).toBe(true);
    expect(r.oldVersionCanWrite).toBe(true);
    expect(r.rollbackMode).toBe("traffic_only");
    expect(r.requiresBackfill).toBe(false);
    expect(r.requiresDualWrite).toBe(false);
    expect(r.blockers).toHaveLength(0);
  });

  test("expand: no blockers, traffic_only rollback", () => {
    const r = buildResult("expand");
    expect(r.releaseType).toBe("expand");
    expect(r.oldVersionCanRead).toBe(true);
    expect(r.oldVersionCanWrite).toBe(true);
    expect(r.rollbackMode).toBe("traffic_only");
    expect(r.blockers).toHaveLength(0);
  });

  test("contract: blockers present (oldVersionCanRead false)", () => {
    const r = buildResult("contract");
    expect(r.releaseType).toBe("contract");
    expect(r.oldVersionCanRead).toBe(false);
    expect(r.oldVersionCanWrite).toBe(true);
    expect(r.rollbackMode).toBe("version_only");
    expect(r.requiresBackfill).toBe(true);
    expect(r.requiresDualWrite).toBe(true);
    expect(r.blockers.length).toBeGreaterThan(0);
    expect(r.blockers.some((b) => b.includes("cannot safely read"))).toBe(true);
  });

  test("breaking: multiple blockers", () => {
    const r = buildResult("breaking");
    expect(r.releaseType).toBe("breaking");
    expect(r.oldVersionCanRead).toBe(false);
    expect(r.oldVersionCanWrite).toBe(false);
    expect(r.rollbackMode).toBe("manual");
    // should have blockers for: breaking type, can't read, can't write
    expect(r.blockers.length).toBeGreaterThanOrEqual(3);
    expect(r.blockers.some((b) => b.includes("'breaking'"))).toBe(true);
  });

  test("invalid tenant overrides produce blockers", () => {
    const r = buildResult("safe", [{ tenantId: "t1", target: "entity.field", status: "invalid" }]);
    expect(r.blockers.some((b) => b.includes("tenant=t1"))).toBe(true);
  });

  test("valid/needs_migration tenant overrides do not block", () => {
    const r = buildResult("safe", [
      { tenantId: "t1", target: "entity.field", status: "valid" },
      { tenantId: "t2", target: "entity.field2", status: "needs_migration" },
    ]);
    expect(r.blockers).toHaveLength(0);
  });
});

// ── analyzeMigrationSql ───────────────────────────────────────────────────────

describe("analyzeMigrationSql", () => {
  test("pure expand migration produces expand result", () => {
    const sql = `CREATE TABLE "new_table" ("id" uuid PRIMARY KEY);
--> statement-breakpoint
ALTER TABLE "t" ADD COLUMN "extra" jsonb;`;
    const analysis = analyzeMigrationSql(sql, "0001_test.sql");
    expect(analysis.file).toBe("0001_test.sql");
    expect(analysis.result.releaseType).toBe("expand");
    expect(analysis.result.blockers).toHaveLength(0);
  });

  test("migration with RENAME COLUMN produces contract result with blockers", () => {
    const sql = `ALTER TABLE "approvals" RENAME COLUMN "metadata" TO "actors_snapshot";`;
    const analysis = analyzeMigrationSql(sql);
    expect(analysis.result.releaseType).toBe("contract");
    expect(analysis.result.blockers.length).toBeGreaterThan(0);
  });

  test("migration mixing expand + breaking yields breaking overall", () => {
    const sql = `CREATE TABLE "new_t" ("id" uuid PRIMARY KEY);
--> statement-breakpoint
ALTER TABLE "existing" ADD COLUMN "required" text NOT NULL;`;
    const analysis = analyzeMigrationSql(sql);
    expect(analysis.result.releaseType).toBe("breaking");
  });

  test("empty file → safe", () => {
    const analysis = analyzeMigrationSql("", "empty.sql");
    expect(analysis.result.releaseType).toBe("safe");
    expect(analysis.result.blockers).toHaveLength(0);
  });

  test("statements array has one entry per parsed statement", () => {
    const sql = `CREATE TABLE "a" ();
--> statement-breakpoint
ALTER TABLE "a" ADD COLUMN "b" text;`;
    const analysis = analyzeMigrationSql(sql);
    expect(analysis.statements).toHaveLength(2);
  });
});

// ── checkReleaseCompatibility (file system) ───────────────────────────────────

describe("checkReleaseCompatibility", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `linchkit-rc-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("non-existent directory → safe", async () => {
    const r = await checkReleaseCompatibility(join(tmpDir, "does-not-exist"));
    expect(r.releaseType).toBe("safe");
  });

  test("empty directory → safe", async () => {
    const r = await checkReleaseCompatibility(tmpDir);
    expect(r.releaseType).toBe("safe");
  });

  test("single expand migration → expand", async () => {
    await writeFile(
      join(tmpDir, "0001_create_table.sql"),
      `CREATE TABLE "foo" ("id" uuid PRIMARY KEY);`,
    );
    const r = await checkReleaseCompatibility(tmpDir);
    expect(r.releaseType).toBe("expand");
  });

  test("multiple migrations — worst wins (contract)", async () => {
    await writeFile(join(tmpDir, "0001_expand.sql"), `CREATE TABLE "foo" ("id" uuid PRIMARY KEY);`);
    await writeFile(
      join(tmpDir, "0002_contract.sql"),
      `ALTER TABLE "foo" RENAME COLUMN "old" TO "new";`,
    );
    const r = await checkReleaseCompatibility(tmpDir);
    expect(r.releaseType).toBe("contract");
  });

  test("breaking migration → blockers non-empty", async () => {
    await writeFile(
      join(tmpDir, "0001_breaking.sql"),
      `ALTER TABLE "t" ADD COLUMN "required" text NOT NULL;`,
    );
    const r = await checkReleaseCompatibility(tmpDir);
    expect(r.releaseType).toBe("breaking");
    expect(r.blockers.length).toBeGreaterThan(0);
  });

  test("non-sql files are ignored", async () => {
    await writeFile(join(tmpDir, "_journal.json"), `{"version":"7"}`);
    await writeFile(join(tmpDir, "0001_safe.sql"), `CREATE INDEX "idx" ON "t" USING btree ("id");`);
    const r = await checkReleaseCompatibility(tmpDir);
    // DROP INDEX is safe, CREATE INDEX is expand
    expect(r.releaseType).toBe("expand");
  });
});

// ── analyzeFile ───────────────────────────────────────────────────────────────

describe("analyzeFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `linchkit-af-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("analyzes an actual SQL file", async () => {
    const filePath = join(tmpDir, "0001_test.sql");
    await writeFile(filePath, `ALTER TABLE "t" ADD COLUMN "extra" jsonb;`);
    const analysis = await analyzeFile(filePath);
    expect(analysis.file).toBe("0001_test.sql");
    expect(analysis.result.releaseType).toBe("expand");
  });
});
