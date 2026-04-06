/**
 * Built-in doctor checks — core health checks that ship with LinchKit.
 *
 * These checks cover runtime environment, database, entity/action definitions,
 * and code quality tooling. Capability-specific checks are registered by
 * their respective capability packages.
 */

import type { DoctorCheck, DoctorCheckResult, DoctorContext } from "./doctor-registry";

// ── Helpers ─────────────────────────────────────────────────────

/** Run a shell command and return { exitCode, stdout, stderr } */
async function runCommand(
  cmd: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Runtime checks ──────────────────────────────────────────────

export const bunRuntimeCheck: DoctorCheck = {
  name: "bun-runtime",
  description: "Check that Bun runtime is available",
  category: "runtime",
  async run(ctx: DoctorContext): Promise<DoctorCheckResult> {
    const result = await runCommand(["bun", "--version"], ctx.projectRoot);
    if (result.exitCode === 0 && result.stdout) {
      return {
        name: "bun-runtime",
        status: "pass",
        message: `Bun ${result.stdout} detected`,
      };
    }
    return {
      name: "bun-runtime",
      status: "fail",
      message: "Bun runtime not found",
      suggestion: "Install Bun: https://bun.sh/docs/installation",
    };
  },
};

export const nodeEnvCheck: DoctorCheck = {
  name: "node-env",
  description: "Check that NODE_ENV is set",
  category: "runtime",
  async run(): Promise<DoctorCheckResult> {
    const nodeEnv = process.env.NODE_ENV;
    if (nodeEnv) {
      return {
        name: "node-env",
        status: "pass",
        message: `NODE_ENV=${nodeEnv}`,
      };
    }
    return {
      name: "node-env",
      status: "warn",
      message: "NODE_ENV is not set",
      suggestion: "Set NODE_ENV to 'development' or 'production' for proper behavior",
    };
  },
};

// ── Database checks ─────────────────────────────────────────────

export const databaseConnectionCheck: DoctorCheck = {
  name: "database-connection",
  description: "Check database connectivity",
  category: "database",
  async run(ctx: DoctorContext): Promise<DoctorCheckResult> {
    if (!ctx.hasDatabase) {
      return {
        name: "database-connection",
        status: "skip",
        message: "No database configured (using InMemoryStore)",
      };
    }

    // Try to connect using the DATABASE_URL env var
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      return {
        name: "database-connection",
        status: "fail",
        message: "DATABASE_URL environment variable is not set",
        suggestion: "Set DATABASE_URL to your PostgreSQL connection string",
      };
    }

    try {
      // Attempt a lightweight connection test via pg driver
      const { createDatabase, checkConnection, closeDatabase } = await import(
        "../persistence/database"
      );
      const db = createDatabase({ url: dbUrl });
      const ok = await checkConnection(db);
      await closeDatabase();
      if (ok) {
        return {
          name: "database-connection",
          status: "pass",
          message: "Database connection successful",
        };
      }
      return {
        name: "database-connection",
        status: "fail",
        message: "Database connection check returned false",
        suggestion: "Verify DATABASE_URL and ensure PostgreSQL is running",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        name: "database-connection",
        status: "fail",
        message: `Database connection failed: ${msg}`,
        suggestion: "Verify DATABASE_URL and ensure PostgreSQL is running",
      };
    }
  },
};

export const databaseMigrationsCheck: DoctorCheck = {
  name: "database-migrations",
  description: "Check for pending database migrations",
  category: "database",
  async run(ctx: DoctorContext): Promise<DoctorCheckResult> {
    if (!ctx.hasDatabase) {
      return {
        name: "database-migrations",
        status: "skip",
        message: "No database configured — skipping migration check",
      };
    }

    // Check if drizzle migrations directory exists
    const { existsSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const migrationsDir = resolve(ctx.projectRoot, "drizzle/migrations");

    if (!existsSync(migrationsDir)) {
      return {
        name: "database-migrations",
        status: "warn",
        message: "No migrations directory found",
        suggestion: "Run 'linch db generate' to create initial migrations",
      };
    }

    return {
      name: "database-migrations",
      status: "pass",
      message: "Migrations directory exists",
    };
  },
};

// ── Definitions checks ──────────────────────────────────────────

export const entityDefinitionsCheck: DoctorCheck = {
  name: "entity-definitions",
  description: "Validate registered entity definitions",
  category: "definitions",
  async run(ctx: DoctorContext): Promise<DoctorCheckResult> {
    const config = ctx.config as Record<string, unknown> | undefined;
    const capabilities = (config?.capabilities ?? []) as Array<{
      entities?: Array<{ name: string }>;
    }>;

    let entityCount = 0;
    for (const cap of capabilities) {
      if (cap.entities) entityCount += cap.entities.length;
    }

    if (entityCount === 0) {
      return {
        name: "entity-definitions",
        status: "warn",
        message: "No entity definitions found",
        suggestion: "Define entities in your capability using defineEntity()",
      };
    }

    return {
      name: "entity-definitions",
      status: "pass",
      message: `${entityCount} entity definition(s) registered`,
    };
  },
};

export const actionDefinitionsCheck: DoctorCheck = {
  name: "action-definitions",
  description: "Validate registered action definitions",
  category: "definitions",
  async run(ctx: DoctorContext): Promise<DoctorCheckResult> {
    const config = ctx.config as Record<string, unknown> | undefined;
    const capabilities = (config?.capabilities ?? []) as Array<{
      actions?: Array<{ name: string }>;
    }>;

    let actionCount = 0;
    for (const cap of capabilities) {
      if (cap.actions) actionCount += cap.actions.length;
    }

    if (actionCount === 0) {
      return {
        name: "action-definitions",
        status: "warn",
        message: "No action definitions found",
        suggestion: "Define actions in your capability using defineAction()",
      };
    }

    return {
      name: "action-definitions",
      status: "pass",
      message: `${actionCount} action definition(s) registered`,
    };
  },
};

// ── Quality checks ──────────────────────────────────────────────

export const typescriptCheck: DoctorCheck = {
  name: "typescript",
  description: "Run TypeScript type checking",
  category: "quality",
  async run(ctx: DoctorContext): Promise<DoctorCheckResult> {
    const result = await runCommand(["bunx", "tsc", "--noEmit"], ctx.projectRoot);
    if (result.exitCode === 0) {
      return {
        name: "typescript",
        status: "pass",
        message: "TypeScript check passed",
      };
    }

    // Count error lines
    const errorLines = result.stdout
      .split("\n")
      .filter((line) => line.includes("error TS"))
      .length;

    return {
      name: "typescript",
      status: "fail",
      message: `TypeScript check failed (${errorLines || "unknown number of"} error(s))`,
      suggestion: "Run 'bunx tsc --noEmit' to see full error output",
    };
  },
};

export const biomeLintCheck: DoctorCheck = {
  name: "biome-lint",
  description: "Run Biome linting",
  category: "quality",
  async run(ctx: DoctorContext): Promise<DoctorCheckResult> {
    const result = await runCommand(
      ["bunx", "@biomejs/biome", "check", "."],
      ctx.projectRoot,
    );
    if (result.exitCode === 0) {
      return {
        name: "biome-lint",
        status: "pass",
        message: "Biome lint passed",
      };
    }
    return {
      name: "biome-lint",
      status: "fail",
      message: "Biome lint check found issues",
      suggestion: "Run 'bunx @biomejs/biome check .' to see lint issues",
    };
  },
};

// ── All built-in checks ────────────────────────────────────────

export const builtinChecks: DoctorCheck[] = [
  bunRuntimeCheck,
  nodeEnvCheck,
  databaseConnectionCheck,
  databaseMigrationsCheck,
  entityDefinitionsCheck,
  actionDefinitionsCheck,
  typescriptCheck,
  biomeLintCheck,
];
