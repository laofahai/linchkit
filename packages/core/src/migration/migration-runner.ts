/**
 * Migration Runner
 *
 * Orchestrates end-to-end migration from external systems into LinchKit.
 * Supports dry-run mode, resume from last processed offset, and progress tracking.
 */

import type { SchemaDefinition } from "../types/schema";
import { type DataImporterOptions, DataImporter, type ImportResult, type ImportSource } from "./data-importer";
import { type FieldMapping, SchemaMapper } from "./schema-mapper";

// ── Migration Plan ──────────────────────────────────────────

export interface MigrationPlan {
  /** Unique name for this migration (used for resume tracking) */
  name: string;
  /** Description of what this migration does */
  description?: string;
  /** The import source */
  source: ImportSource;
  /** Target schema definition */
  targetSchema: SchemaDefinition;
  /** Field mappings from source → target */
  mappings: FieldMapping[];
  /** Writer function that persists a mapped record */
  writer: (record: Record<string, unknown>) => Promise<void>;
  /** Batch size (default: 100) */
  batchSize?: number;
  /** Error mode (default: "skip") */
  errorMode?: "skip" | "fail-fast";
}

// ── Migration Result ────────────────────────────────────────

export interface MigrationResult extends ImportResult {
  /** Migration plan name */
  planName: string;
  /** Whether this was a dry run */
  dryRun: boolean;
  /** Mapping validation errors (if any) */
  validationErrors: string[];
  /** Mapping validation warnings */
  validationWarnings: string[];
}

// ── Migration Runner Options ────────────────────────────────

export interface MigrationRunnerOptions {
  /** When true, validate and map but don't write. Default: false. */
  dryRun?: boolean;
  /** Resume offset — skip this many records from the start. Default: 0. */
  resumeOffset?: number;
  /** Progress callback */
  onProgress?: (info: {
    planName: string;
    total: number;
    processed: number;
    succeeded: number;
    failed: number;
  }) => void;
}

// ── Resume tracker ──────────────────────────────────────────

/** Simple in-memory tracker for last processed offset. Extendable to persistent stores. */
export class MigrationResumeTracker {
  private offsets = new Map<string, number>();

  getOffset(planName: string): number {
    return this.offsets.get(planName) ?? 0;
  }

  setOffset(planName: string, offset: number): void {
    this.offsets.set(planName, offset);
  }

  clear(planName: string): void {
    this.offsets.delete(planName);
  }
}

// ── Resume-aware import source wrapper ──────────────────────

class OffsetImportSource implements ImportSource {
  readonly name: string;
  constructor(
    private readonly inner: ImportSource,
    private readonly skipOffset: number,
  ) {
    this.name = inner.name;
  }

  async totalCount(): Promise<number> {
    const total = await this.inner.totalCount();
    return total < 0 ? total : Math.max(0, total - this.skipOffset);
  }

  async readBatch(batchSize: number, offset: number): Promise<Record<string, unknown>[]> {
    return this.inner.readBatch(batchSize, offset + this.skipOffset);
  }

  async close(): Promise<void> {
    await this.inner.close?.();
  }
}

// ── MigrationRunner class ───────────────────────────────────

export class MigrationRunner {
  private readonly resumeTracker: MigrationResumeTracker;

  constructor(options?: { resumeTracker?: MigrationResumeTracker }) {
    this.resumeTracker = options?.resumeTracker ?? new MigrationResumeTracker();
  }

  /** Execute a migration plan */
  async run(plan: MigrationPlan, options?: MigrationRunnerOptions): Promise<MigrationResult> {
    const dryRun = options?.dryRun ?? false;
    const resumeOffset = options?.resumeOffset ?? this.resumeTracker.getOffset(plan.name);

    // 1. Build and validate mapper
    const mapper = new SchemaMapper({
      mappings: plan.mappings,
      targetSchema: plan.targetSchema,
    });

    const validation = mapper.validate();

    if (!validation.valid) {
      return {
        planName: plan.name,
        dryRun,
        totalProcessed: 0,
        succeeded: 0,
        failed: 0,
        errors: [],
        durationMs: 0,
        validationErrors: validation.errors,
        validationWarnings: validation.warnings,
      };
    }

    // 2. Build writer (noop for dry-run)
    const writer = dryRun ? async (_record: Record<string, unknown>) => {} : plan.writer;

    // 3. Wrap source with resume offset
    const source = resumeOffset > 0 ? new OffsetImportSource(plan.source, resumeOffset) : plan.source;

    // 4. Build and run importer
    const importerOptions: DataImporterOptions = {
      source,
      mapper,
      writer,
      batchSize: plan.batchSize ?? 100,
      errorMode: plan.errorMode ?? "skip",
      onProgress: options?.onProgress
        ? (progress) => {
            options.onProgress!({
              planName: plan.name,
              total: progress.total,
              processed: progress.processed,
              succeeded: progress.succeeded,
              failed: progress.failed,
            });
          }
        : undefined,
    };

    const importer = new DataImporter(importerOptions);
    const result = await importer.run();

    // 5. Update resume tracker
    this.resumeTracker.setOffset(plan.name, resumeOffset + result.totalProcessed);

    return {
      ...result,
      planName: plan.name,
      dryRun,
      validationErrors: validation.errors,
      validationWarnings: validation.warnings,
    };
  }

  /** Get the resume tracker for manual offset management */
  getResumeTracker(): MigrationResumeTracker {
    return this.resumeTracker;
  }
}
