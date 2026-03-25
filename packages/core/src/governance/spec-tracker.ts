/**
 * Specification implementation tracker
 *
 * Tracks which specs exist in docs/specs/ and their implementation status.
 * Generates progress reports in Markdown format per spec 37.
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

// ── Types ────────────────────────────────────────────

export type SpecStatusValue = "planned" | "in-progress" | "done" | "deprecated";

export interface SpecStatus {
  /** Human-readable spec name (derived from filename) */
  name: string;
  /** Relative path to spec file (e.g. "docs/specs/03_schema.md") */
  specFile: string;
  /** Implementation status */
  status: SpecStatusValue;
  /** Optional notes */
  notes?: string;
}

export interface SpecProgressReport {
  /** Total number of tracked specs */
  total: number;
  /** Counts by status */
  counts: Record<SpecStatusValue, number>;
  /** All spec statuses */
  specs: SpecStatus[];
  /** Completion percentage (done / total, excluding deprecated) */
  completionPercent: number;
  /** Report generation timestamp */
  generatedAt: Date;
}

// ── SpecTracker class ────────────────────────────────

export class SpecTracker {
  private specs = new Map<string, SpecStatus>();

  /** Register or update a spec entry */
  register(spec: SpecStatus): void {
    this.specs.set(spec.specFile, spec);
  }

  /** Update the status of an existing spec */
  updateStatus(specFile: string, status: SpecStatusValue, notes?: string): boolean {
    const existing = this.specs.get(specFile);
    if (!existing) return false;
    existing.status = status;
    if (notes !== undefined) existing.notes = notes;
    return true;
  }

  /** Get status of a specific spec */
  getStatus(specFile: string): SpecStatus | undefined {
    return this.specs.get(specFile);
  }

  /** Get all registered specs */
  getAllSpecs(): SpecStatus[] {
    return Array.from(this.specs.values());
  }

  /** Generate a progress report */
  generateReport(): SpecProgressReport {
    const specs = this.getAllSpecs();
    const counts: Record<SpecStatusValue, number> = {
      planned: 0,
      "in-progress": 0,
      done: 0,
      deprecated: 0,
    };

    for (const spec of specs) {
      counts[spec.status]++;
    }

    const nonDeprecated = specs.length - counts.deprecated;
    const completionPercent =
      nonDeprecated === 0 ? 100 : Math.round((counts.done / nonDeprecated) * 100);

    return {
      total: specs.length,
      counts,
      specs,
      completionPercent,
      generatedAt: new Date(),
    };
  }

  /**
   * Scan a specs directory and register all found .md files.
   * Files without a tracked status default to "planned".
   */
  async scanDirectory(specsDir: string): Promise<number> {
    let count = 0;
    try {
      const entries = await readdir(specsDir);
      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        const specFile = join("docs/specs", entry);
        if (!this.specs.has(specFile)) {
          const name = deriveSpecName(entry);
          const status = await detectStatusFromFile(join(specsDir, entry));
          this.register({ name, specFile, status });
        }
        count++;
      }
    } catch {
      // Directory may not exist; return 0
    }
    return count;
  }
}

// ── Report generation ────────────────────────────────

/**
 * Generate a Markdown summary of spec implementation progress.
 */
export function generateSpecReport(report: SpecProgressReport): string {
  const lines: string[] = [];

  lines.push("# Specification Progress Report");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt.toISOString()}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total specs | ${report.total} |`);
  lines.push(`| Done | ${report.counts.done} |`);
  lines.push(`| In progress | ${report.counts["in-progress"]} |`);
  lines.push(`| Planned | ${report.counts.planned} |`);
  lines.push(`| Deprecated | ${report.counts.deprecated} |`);
  lines.push(`| **Completion** | **${report.completionPercent}%** |`);
  lines.push("");
  lines.push("## Details");
  lines.push("");
  lines.push("| Spec | File | Status | Notes |");
  lines.push("|------|------|--------|-------|");

  const statusIcon: Record<SpecStatusValue, string> = {
    done: "[x]",
    "in-progress": "[-]",
    planned: "[ ]",
    deprecated: "[~]",
  };

  for (const spec of report.specs) {
    const icon = statusIcon[spec.status];
    const notes = spec.notes ?? "";
    lines.push(`| ${icon} ${spec.name} | ${spec.specFile} | ${spec.status} | ${notes} |`);
  }

  return lines.join("\n");
}

// ── Internal helpers ─────────────────────────────────

/** Derive a human-readable name from a spec filename like "03_schema.md" */
function deriveSpecName(filename: string): string {
  return basename(filename, ".md")
    .replace(/^\d+_/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Detect status from file frontmatter (looks for draft/deprecated markers) */
async function detectStatusFromFile(filePath: string): Promise<SpecStatusValue> {
  try {
    const content = await readFile(filePath, "utf-8");
    const head = content.slice(0, 500).toLowerCase();
    if (head.includes("draft")) return "in-progress";
    if (head.includes("deprecated")) return "deprecated";
    if (head.includes("historical")) return "deprecated";
    // Default: treat existing spec files as done (they exist and are active)
    return "done";
  } catch {
    return "planned";
  }
}
