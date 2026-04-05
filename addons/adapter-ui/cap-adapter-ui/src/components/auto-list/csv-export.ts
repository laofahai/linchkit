/**
 * CSV export utility for AutoList.
 *
 * Generates RFC 4180-compliant CSV from record data and triggers a browser download.
 */

import type { ViewFieldConfig } from "@linchkit/core/types";

/** Escape a cell value for CSV (handles commas, quotes, newlines). */
function escapeCsvCell(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object") {
    // Arrays and objects → JSON string
    try {
      return escapeCsvString(JSON.stringify(value));
    } catch {
      return "";
    }
  }
  return escapeCsvString(String(value));
}

/** Wrap in quotes if the string contains comma, quote, or newline. */
function escapeCsvString(str: string): string {
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export interface CsvExportOptions {
  /** View fields defining columns and labels. */
  fields: ViewFieldConfig[];
  /** Row data to export. */
  data: Record<string, unknown>[];
  /** Schema name used in the filename. */
  entityName: string;
  /** Optional label resolver for field labels. */
  resolveLabel?: (label: string | undefined, fallback: string) => string;
}

/** Build CSV string from fields and data rows. */
export function buildCsv({ fields, data, resolveLabel }: CsvExportOptions): string {
  const headers = fields.map((f) => {
    const label = resolveLabel ? resolveLabel(f.label, f.field) : (f.label ?? f.field);
    return escapeCsvString(label);
  });

  const rows = data.map((row) => fields.map((f) => escapeCsvCell(row[f.field])).join(","));

  return [headers.join(","), ...rows].join("\r\n");
}

/** Trigger a CSV file download in the browser. */
export function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  // Cleanup
  setTimeout(() => {
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, 100);
}

/** Format current date as YYYYMMDD for filenames. */
function formatDate(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

/** Export data as CSV and trigger download. */
export function exportCsv(options: CsvExportOptions): void {
  const csv = buildCsv(options);
  const filename = `${options.entityName}_${formatDate()}.csv`;
  downloadCsv(csv, filename);
}
