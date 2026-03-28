/**
 * Data Importer
 *
 * Imports data from external sources into LinchKit schemas.
 * Supports pluggable source adapters (CSV, JSON, custom) with
 * batch processing and progress tracking.
 */

import type { SchemaMapper } from "./schema-mapper";

// ── Import Source interface ─────────────────────────────────

/** Interface for reading records from an external source */
export interface ImportSource {
  /** Human-readable name of this source */
  readonly name: string;
  /** Total number of records (if known ahead of time). Return -1 if unknown. */
  totalCount(): Promise<number>;
  /** Read the next batch of records. Returns empty array when exhausted. */
  readBatch(batchSize: number, offset: number): Promise<Record<string, unknown>[]>;
  /** Optional cleanup (close file handles, etc.) */
  close?(): Promise<void>;
}

// ── CSV Import Source ───────────────────────────────────────

export interface CSVImportSourceOptions {
  /** CSV content as string */
  content: string;
  /** Column delimiter (default: ",") */
  delimiter?: string;
  /** Whether first row is header (default: true) */
  hasHeader?: boolean;
}

/** Parse a CSV line respecting quoted fields */
function parseCSVLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++; // skip escaped quote
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Simple CSV parser. Limitation: does not handle RFC 4180 multiline quoted fields
 * (newlines inside quoted values). For complex CSV files, use a dedicated CSV library.
 */
export class CSVImportSource implements ImportSource {
  readonly name = "csv";
  private readonly records: Record<string, unknown>[];

  constructor(options: CSVImportSourceOptions) {
    const delimiter = options.delimiter ?? ",";
    const lines = options.content.split(/\r?\n/).filter((l) => l.trim().length > 0);

    if (lines.length === 0) {
      this.records = [];
      return;
    }

    const hasHeader = options.hasHeader ?? true;
    // biome-ignore lint/style/noNonNullAssertion: index guaranteed in bounds after empty check
    const firstLine = lines[0]!;
    const headers = hasHeader
      ? parseCSVLine(firstLine, delimiter).map((h) => h.trim())
      : parseCSVLine(firstLine, delimiter).map((_, i) => `col_${i}`);

    const dataStart = hasHeader ? 1 : 0;
    this.records = [];

    for (let i = dataStart; i < lines.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: index guaranteed in bounds by loop condition
      const line = lines[i]!;
      const values = parseCSVLine(line, delimiter);
      const record: Record<string, unknown> = {};
      for (let j = 0; j < headers.length; j++) {
        // biome-ignore lint/style/noNonNullAssertion: index guaranteed in bounds by loop condition
        record[headers[j]!] = values[j] ?? "";
      }
      this.records.push(record);
    }
  }

  async totalCount(): Promise<number> {
    return this.records.length;
  }

  async readBatch(batchSize: number, offset: number): Promise<Record<string, unknown>[]> {
    return this.records.slice(offset, offset + batchSize);
  }
}

// ── JSON Import Source ──────────────────────────────────────

export interface JSONImportSourceOptions {
  /** JSON data — either an array of records or a single record */
  data: Record<string, unknown>[] | Record<string, unknown>;
}

export class JSONImportSource implements ImportSource {
  readonly name = "json";
  private readonly records: Record<string, unknown>[];

  constructor(options: JSONImportSourceOptions) {
    this.records = Array.isArray(options.data) ? options.data : [options.data];
  }

  async totalCount(): Promise<number> {
    return this.records.length;
  }

  async readBatch(batchSize: number, offset: number): Promise<Record<string, unknown>[]> {
    return this.records.slice(offset, offset + batchSize);
  }
}

// ── Import options and result types ─────────────────────────

export type ErrorMode = "skip" | "fail-fast";

export interface ImportProgress {
  /** Total records (if known) */
  total: number;
  /** Records processed so far */
  processed: number;
  /** Records successfully imported */
  succeeded: number;
  /** Records that failed */
  failed: number;
}

export interface ImportRecordError {
  /** 0-based index of the record in the source */
  index: number;
  /** The source record that failed */
  record: Record<string, unknown>;
  /** Error message */
  message: string;
}

export interface ImportResult {
  /** Total records processed */
  totalProcessed: number;
  /** Successfully imported count */
  succeeded: number;
  /** Failed count */
  failed: number;
  /** Individual errors (when errorMode is "skip") */
  errors: ImportRecordError[];
  /** Duration in milliseconds */
  durationMs: number;
}

export interface DataImporterOptions {
  /** The source to read from */
  source: ImportSource;
  /** Schema mapper for field mapping and transforms */
  mapper: SchemaMapper;
  /** Function that writes a record to the target system */
  writer: (record: Record<string, unknown>) => Promise<void>;
  /** Number of records to process per batch (default: 100) */
  batchSize?: number;
  /** Error handling mode (default: "skip") */
  errorMode?: ErrorMode;
  /** Progress callback, called after each batch */
  onProgress?: (progress: ImportProgress) => void;
}

// ── DataImporter class ──────────────────────────────────────

export class DataImporter {
  private readonly source: ImportSource;
  private readonly mapper: SchemaMapper;
  private readonly writer: (record: Record<string, unknown>) => Promise<void>;
  private readonly batchSize: number;
  private readonly errorMode: ErrorMode;
  private readonly onProgress?: (progress: ImportProgress) => void;

  constructor(options: DataImporterOptions) {
    this.source = options.source;
    this.mapper = options.mapper;
    this.writer = options.writer;
    this.batchSize = options.batchSize ?? 100;
    this.errorMode = options.errorMode ?? "skip";
    this.onProgress = options.onProgress;
  }

  /** Run the import process */
  async run(): Promise<ImportResult> {
    const startTime = Date.now();
    const total = await this.source.totalCount();
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    const errors: ImportRecordError[] = [];
    let offset = 0;

    try {
      while (true) {
        const batch = await this.source.readBatch(this.batchSize, offset);
        if (batch.length === 0) break;

        for (let i = 0; i < batch.length; i++) {
          const globalIndex = offset + i;
          // biome-ignore lint/style/noNonNullAssertion: index guaranteed in bounds by loop condition
          const sourceRecord = batch[i]!;

          try {
            const mapped = this.mapper.mapRecord(sourceRecord);

            if (mapped.errors.length > 0) {
              const msg = mapped.errors.map((e) => `${e.field}: ${e.message}`).join("; ");
              throw new Error(`Mapping errors: ${msg}`);
            }

            await this.writer(mapped.data);
            succeeded++;
          } catch (err) {
            failed++;
            const error: ImportRecordError = {
              index: globalIndex,
              record: sourceRecord as Record<string, unknown>,
              message: err instanceof Error ? err.message : String(err),
            };
            errors.push(error);

            if (this.errorMode === "fail-fast") {
              processed++;
              return {
                totalProcessed: processed,
                succeeded,
                failed,
                errors,
                durationMs: Date.now() - startTime,
              };
            }
          }

          processed++;
        }

        offset += batch.length;

        this.onProgress?.({
          total,
          processed,
          succeeded,
          failed,
        });
      }
    } finally {
      await this.source.close?.();
    }

    return {
      totalProcessed: processed,
      succeeded,
      failed,
      errors,
      durationMs: Date.now() - startTime,
    };
  }
}
