/**
 * linch overlay — Runtime overlay field management commands
 *
 * Subcommands:
 *   list     — List overlay fields (optionally filtered by entity)
 *   promote  — Promote an overlay field to a code-defined field
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FieldOverlayRecord, LinchKitConfig } from "@linchkit/core";
import {
  closeDatabase,
  createDatabase,
  DrizzleOverlayStore,
  generatePromotionPlan,
} from "@linchkit/core/server";
import { defineCommand } from "citty";
import { loadConfig } from "../utils/load-config";

/** Load config, returning null on failure */
async function _tryLoadConfig(): Promise<LinchKitConfig | null> {
  try {
    const { config } = await loadConfig();
    return config;
  } catch {
    console.error("[linch] Failed to load config. Run from project root with linchkit.config.ts.");
    return null;
  }
}

/** Create a DrizzleOverlayStore from DATABASE_URL */
function createOverlayStore(): { store: DrizzleOverlayStore; cleanup: () => Promise<void> } | null {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("[linch] DATABASE_URL is required. Set it in your environment.");
    return null;
  }
  const db = createDatabase({ url: dbUrl });
  const store = new DrizzleOverlayStore(db);
  return { store, cleanup: () => closeDatabase() };
}

/** Format a date for display */
function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── list subcommand ──────────────────────────────────────────

/** CLI subcommand: list runtime overlay fields, optionally filtered by entity name. */
export const overlayListCommand = defineCommand({
  meta: {
    name: "list",
    description: "List runtime overlay fields",
  },
  args: {
    entity: {
      type: "string",
      description: "Filter by entity name",
    },
    json: {
      type: "boolean",
      description: "Output as JSON (for AI tools)",
      default: false,
    },
  },
  async run({ args }) {
    const conn = createOverlayStore();
    if (!conn) return process.exit(1);

    try {
      let overlays: FieldOverlayRecord[];
      if (args.entity) {
        overlays = await conn.store.getOverlays(args.entity);
      } else {
        overlays = await conn.store.getAllOverlays();
      }

      if (args.json) {
        console.log(JSON.stringify(overlays, null, 2));
        return;
      }

      if (overlays.length === 0) {
        console.log("[linch] No overlay fields found.");
        return;
      }

      // Table header
      console.log("");
      console.log(
        `${padR("Entity", 25) + padR("Field", 20) + padR("Type", 10) + padR("Status", 12)}Created`,
      );
      console.log("-".repeat(80));

      for (const o of overlays) {
        console.log(
          padR(o.entityName, 25) +
            padR(o.fieldName, 20) +
            padR(o.fieldType, 10) +
            padR(o.status, 12) +
            fmtDate(o.createdAt),
        );
      }
      console.log(`\nTotal: ${overlays.length} overlay field(s)`);
    } finally {
      await conn.cleanup();
    }
  },
});

// ── promote subcommand ───────────────────────────────────────

/** CLI subcommand: promote overlay field(s) to code-defined fields with generated migration SQL. */
export const overlayPromoteCommand = defineCommand({
  meta: {
    name: "promote",
    description: "Promote overlay field(s) to code-defined fields",
  },
  args: {
    entity: {
      type: "string",
      description: "Entity name (required)",
      required: true,
    },
    field: {
      type: "string",
      description: "Field name to promote (or use --all)",
    },
    all: {
      type: "boolean",
      description: "Promote all active overlay fields for the entity",
      default: false,
    },
  },
  async run({ args }) {
    if (!args.entity) {
      console.error("[linch] --entity is required");
      return process.exit(1);
    }
    if (!args.field && !args.all) {
      console.error("[linch] Specify --field <name> or --all");
      return process.exit(1);
    }

    const conn = createOverlayStore();
    if (!conn) return process.exit(1);

    try {
      const overlays = await conn.store.getOverlays(args.entity);
      const active = overlays.filter((o) => o.status === "active");

      if (active.length === 0) {
        console.log(`[linch] No active overlay fields for entity '${args.entity}'.`);
        return;
      }

      // Determine which overlays to promote
      let targets: FieldOverlayRecord[];
      if (args.all) {
        targets = active;
      } else {
        const found = active.find((o) => o.fieldName === args.field);
        if (!found) {
          console.error(
            `[linch] Overlay field '${args.field}' not found (active) on entity '${args.entity}'.`,
          );
          console.error(
            `[linch] Active fields: ${active.map((o) => o.fieldName).join(", ") || "(none)"}`,
          );
          return process.exit(1);
        }
        targets = [found];
      }

      // Migration output directory
      const migDir = join(process.cwd(), "drizzle", "migrations", "manual");
      if (!existsSync(migDir)) {
        mkdirSync(migDir, { recursive: true });
      }

      for (const overlay of targets) {
        const plan = generatePromotionPlan(overlay);

        // Write migration SQL file
        const migFile = join(
          migDir,
          `promote_${sanitizeForFilename(overlay.entityName)}_${sanitizeForFilename(overlay.fieldName)}.sql`,
        );

        if (existsSync(migFile)) {
          console.warn(`[linch] Migration file already exists: ${migFile}`);
          console.warn(
            "[linch] A previous promote may have partially failed. Skipping this field.",
          );
          console.warn("[linch] Delete the file manually and re-run if you want to regenerate it.");
          continue;
        }

        writeFileSync(migFile, plan.migrationSql, "utf-8");

        // Mark as promoted in the database — clean up file on failure
        try {
          await conn.store.updateOverlay(overlay.id, { status: "promoted" });
        } catch (err) {
          // Remove orphaned migration file so state stays consistent
          try {
            unlinkSync(migFile);
          } catch {
            // Best-effort cleanup
          }
          throw err;
        }

        // Output summary
        console.log("");
        console.log(
          `✓ Overlay field '${overlay.fieldName}' on entity '${overlay.entityName}' promoted.`,
        );
        console.log("");
        console.log("  1. Add this field to your entity definition:");
        console.log(`     ${plan.fieldDefinitionCode}`);
        console.log("");
        console.log("  2. Migration SQL generated at:");
        console.log(`     ${migFile}`);
        console.log("");
        console.log("  3. Run migration:");
        console.log("     bun run db:migrate");
        console.log("");
        console.log("  4. After migration, run 'bun run db:generate' to sync Drizzle schema.");
      }

      if (targets.length > 1) {
        console.log(`\nPromoted ${targets.length} overlay field(s).`);
      }
    } finally {
      await conn.cleanup();
    }
  },
});

// ── Parent command ───────────────────────────────────────────

/** CLI parent command for runtime overlay field management (list, promote). */
export const overlayCommand = defineCommand({
  meta: {
    name: "overlay",
    description: "Runtime overlay field management",
  },
  subCommands: {
    list: overlayListCommand,
    promote: overlayPromoteCommand,
  },
});

/** Right-pad a string to the given width */
function padR(s: string, width: number): string {
  return s.length >= width ? `${s} ` : s + " ".repeat(width - s.length);
}

/** Sanitize a string for safe use in filenames (prevent path traversal). */
function sanitizeForFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}
