/**
 * ImportDialog — Upload CSV/JSON files to create records in bulk.
 *
 * Features:
 * - Drag-and-drop + click-to-browse file upload
 * - CSV and JSON file support
 * - Preview first 5 rows after upload
 * - Column mapping: match CSV/JSON columns to schema fields
 * - Progress bar during import
 * - Summary: X imported, Y failed with expandable error details
 * - Download CSV template with schema field headers
 */

import type { FieldDefinition, SchemaDefinition } from "@linchkit/core/types";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@linchkit/ui-kit/components";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  FileUp,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSchemaLabel } from "../../i18n/use-schema-label";

// ── Types ────────────────────────────────────────────────────

interface ImportError {
  row: number;
  error: string;
}

interface ImportResult {
  imported: number;
  errors: ImportError[];
}

type ImportPhase = "upload" | "mapping" | "importing" | "done";

interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schema: SchemaDefinition;
  /** Callback after successful import to refresh the list. */
  onImported?: () => void;
}

// ── System fields that should be excluded from import ────────
const SYSTEM_FIELDS = new Set([
  "id", "tenant_id", "created_at", "updated_at",
  "created_by", "updated_by", "_version", "is_deleted",
]);

// ── CSV parser (simple, handles quoted fields) ───────────────

function parseCSVLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
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

function parseCSV(content: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = parseCSVLine(lines[0]!, ",").map((h) => h.trim());
  const rows: Record<string, string>[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]!, ",");
    const record: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      record[headers[j]!] = values[j] ?? "";
    }
    rows.push(record);
  }

  return { headers, rows };
}

function parseJSONData(content: string): { headers: string[]; rows: Record<string, unknown>[] } {
  const parsed = JSON.parse(content);
  const data: Record<string, unknown>[] = Array.isArray(parsed) ? parsed : [parsed];
  if (data.length === 0) return { headers: [], rows: [] };

  // Collect all unique keys across all records
  const keySet = new Set<string>();
  for (const record of data) {
    for (const key of Object.keys(record)) {
      keySet.add(key);
    }
  }
  return { headers: Array.from(keySet), rows: data };
}

// ── Generate CSV template ────────────────────────────────────

function downloadCSVTemplate(schema: SchemaDefinition) {
  const fields = Object.entries(schema.fields)
    .filter(([name]) => !SYSTEM_FIELDS.has(name))
    .map(([name]) => name);

  const csv = `${fields.join(",")}\n`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${schema.name}_template.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

// ── Component ────────────────────────────────────────────────

export function ImportDialog({ open, onOpenChange, schema, onImported }: ImportDialogProps) {
  const { t } = useTranslation();
  const { resolveLabel } = useSchemaLabel();

  const [phase, setPhase] = useState<ImportPhase>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [fileHeaders, setFileHeaders] = useState<string[]>([]);
  const [fileRows, setFileRows] = useState<Record<string, unknown>[]>([]);
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [errorsExpanded, setErrorsExpanded] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Available schema fields for mapping (exclude system fields)
  const schemaFields = useMemo(() => {
    return Object.entries(schema.fields)
      .filter(([name]) => !SYSTEM_FIELDS.has(name))
      .map(([name, def]) => ({
        name,
        label: resolveLabel((def as FieldDefinition).label, name),
        required: (def as FieldDefinition).required ?? false,
      }));
  }, [schema.fields, resolveLabel]);

  // Preview rows (first 5)
  const previewRows = useMemo(() => fileRows.slice(0, 5), [fileRows]);

  const resetState = useCallback(() => {
    setPhase("upload");
    setFile(null);
    setFileHeaders([]);
    setFileRows([]);
    setColumnMapping({});
    setProgress(0);
    setResult(null);
    setErrorsExpanded(false);
    setParseError(null);
    setDragOver(false);
  }, []);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) resetState();
      onOpenChange(open);
    },
    [onOpenChange, resetState],
  );

  // ── File handling ──────────────────────────────────────────

  const processFile = useCallback(
    async (f: File) => {
      setFile(f);
      setParseError(null);

      try {
        const content = await f.text();
        let headers: string[];
        let rows: Record<string, unknown>[];

        if (f.name.endsWith(".json")) {
          const parsed = parseJSONData(content);
          headers = parsed.headers;
          rows = parsed.rows;
        } else {
          // Assume CSV
          const parsed = parseCSV(content);
          headers = parsed.headers;
          rows = parsed.rows;
        }

        if (headers.length === 0) {
          setParseError(t("import.parseError", "Could not parse the file. Please check the format."));
          return;
        }

        setFileHeaders(headers);
        setFileRows(rows);

        // Auto-map columns with matching names
        const autoMapping: Record<string, string> = {};
        const schemaFieldNames = new Set(
          Object.keys(schema.fields).filter((n) => !SYSTEM_FIELDS.has(n)),
        );
        for (const header of headers) {
          const normalized = header.toLowerCase().trim();
          for (const fieldName of schemaFieldNames) {
            if (fieldName.toLowerCase() === normalized) {
              autoMapping[header] = fieldName;
              break;
            }
          }
        }
        setColumnMapping(autoMapping);
        setPhase("mapping");
      } catch {
        setParseError(t("import.parseError", "Could not parse the file. Please check the format."));
      }
    },
    [schema.fields, t],
  );

  const handleFileDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files[0];
      if (f) processFile(f);
    },
    [processFile],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (f) processFile(f);
    },
    [processFile],
  );

  // ── Import execution ──────────────────────────────────────

  const handleImport = useCallback(async () => {
    if (!file || fileRows.length === 0) return;

    setPhase("importing");
    setProgress(0);

    try {
      // Build mapped data
      const mappedRows: Record<string, unknown>[] = [];
      for (const row of fileRows) {
        const mapped: Record<string, unknown> = {};
        for (const [fileCol, schemaField] of Object.entries(columnMapping)) {
          if (schemaField && schemaField !== "__skip__") {
            mapped[schemaField] = row[fileCol];
          }
        }
        // Only include rows that have at least one mapped value
        if (Object.keys(mapped).length > 0) {
          mappedRows.push(mapped);
        }
      }

      if (mappedRows.length === 0) {
        setResult({ imported: 0, errors: [{ row: 0, error: t("import.noMappedData", "No data to import. Please map at least one column.") }] });
        setPhase("done");
        return;
      }

      // Simulate progress while sending the request
      const progressInterval = setInterval(() => {
        setProgress((p) => Math.min(p + 5, 90));
      }, 200);

      const formData = new FormData();
      // Send as JSON blob with the mapping applied
      const blob = new Blob([JSON.stringify(mappedRows)], { type: "application/json" });
      formData.append("file", blob, "import.json");
      formData.append("format", "json");

      const res = await fetch(`/api/schemas/${schema.name}/import`, {
        method: "POST",
        body: formData,
      });

      clearInterval(progressInterval);
      setProgress(100);

      const json = await res.json();

      if (json.success) {
        setResult({
          imported: json.data.imported,
          errors: json.data.errors ?? [],
        });
      } else {
        setResult({
          imported: 0,
          errors: [{ row: 0, error: json.error?.message ?? "Import failed" }],
        });
      }

      setPhase("done");
    } catch (err) {
      setProgress(100);
      setResult({
        imported: 0,
        errors: [{ row: 0, error: err instanceof Error ? err.message : "Import failed" }],
      });
      setPhase("done");
    }
  }, [file, fileRows, columnMapping, schema.name, t]);

  // ── Mapping update ─────────────────────────────────────────

  const updateMapping = useCallback((fileColumn: string, schemaField: string) => {
    setColumnMapping((prev) => ({ ...prev, [fileColumn]: schemaField }));
  }, []);

  // Count mapped columns
  const mappedCount = useMemo(
    () => Object.values(columnMapping).filter((v) => v && v !== "__skip__").length,
    [columnMapping],
  );

  // ── Render ─────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("import.title", "Import Data")}</DialogTitle>
          <DialogDescription>
            {t("import.description", "Upload a CSV or JSON file to create records in bulk.")}
          </DialogDescription>
        </DialogHeader>

        {/* ── Upload phase ─────────────────────────────────── */}
        {phase === "upload" && (
          <div className="space-y-4">
            {/* Drop zone */}
            <div
              className={`relative flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors ${
                dragOver
                  ? "border-primary bg-primary/5"
                  : "border-muted-foreground/25 hover:border-muted-foreground/50"
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleFileDrop}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") fileInputRef.current?.click();
              }}
              role="button"
              tabIndex={0}
            >
              <FileUp className="mb-3 size-10 text-muted-foreground/60" />
              <p className="text-sm font-medium">
                {t("import.dropzone", "Drag and drop a file here, or click to browse")}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("import.acceptedFormats", "Accepted formats: CSV, JSON")}
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.json"
                className="hidden"
                onChange={handleFileSelect}
              />
            </div>

            {parseError && (
              <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                <AlertCircle className="size-4 shrink-0" />
                {parseError}
              </div>
            )}

            {/* Template download */}
            <button
              type="button"
              className="flex items-center gap-1.5 text-sm text-primary hover:underline"
              onClick={() => downloadCSVTemplate(schema)}
            >
              <Download className="size-3.5" />
              {t("import.downloadTemplate", "Download CSV template")}
            </button>
          </div>
        )}

        {/* ── Mapping phase ────────────────────────────────── */}
        {phase === "mapping" && (
          <div className="space-y-4">
            {/* File info */}
            <div className="flex items-center justify-between rounded-md bg-muted p-3">
              <div className="flex items-center gap-2 text-sm">
                <Upload className="size-4 text-muted-foreground" />
                <span className="font-medium">{file?.name}</span>
                <span className="text-muted-foreground">
                  ({fileRows.length} {t("import.rows", "rows")})
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={resetState}
              >
                <X className="size-3.5" />
              </Button>
            </div>

            {/* Column mapping */}
            <div>
              <h4 className="mb-2 text-sm font-medium">
                {t("import.columnMapping", "Column Mapping")}
              </h4>
              <p className="mb-3 text-xs text-muted-foreground">
                {t("import.columnMappingDesc", "Map file columns to schema fields. Unmapped columns will be skipped.")}
              </p>
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {fileHeaders.map((header) => (
                  <div key={header} className="flex items-center gap-3">
                    <span className="w-1/3 truncate text-sm font-mono text-muted-foreground" title={header}>
                      {header}
                    </span>
                    <span className="text-xs text-muted-foreground">&rarr;</span>
                    <Select
                      value={columnMapping[header] ?? "__skip__"}
                      onValueChange={(val) => updateMapping(header, val)}
                    >
                      <SelectTrigger className="w-2/3 h-8 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__skip__">
                          <span className="text-muted-foreground italic">
                            {t("import.skip", "— Skip —")}
                          </span>
                        </SelectItem>
                        {schemaFields.map((f) => (
                          <SelectItem key={f.name} value={f.name}>
                            {f.label}
                            {f.required && <span className="ml-1 text-destructive">*</span>}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </div>

            {/* Preview */}
            {previewRows.length > 0 && (
              <div>
                <h4 className="mb-2 text-sm font-medium">
                  {t("import.preview", "Preview")} ({Math.min(5, fileRows.length)} {t("import.rows", "rows")})
                </h4>
                <div className="overflow-x-auto rounded border border-border">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b bg-muted/50">
                        {fileHeaders
                          .filter((h) => columnMapping[h] && columnMapping[h] !== "__skip__")
                          .map((h) => (
                            <th key={h} className="px-2 py-1.5 text-left font-medium text-muted-foreground">
                              {columnMapping[h]}
                            </th>
                          ))}
                      </tr>
                    </thead>
                    <tbody>
                      {previewRows.map((row, i) => (
                        <tr key={`preview-${i}`} className="border-b last:border-0">
                          {fileHeaders
                            .filter((h) => columnMapping[h] && columnMapping[h] !== "__skip__")
                            .map((h) => (
                              <td key={h} className="px-2 py-1.5 truncate max-w-[200px]">
                                {String(row[h] ?? "")}
                              </td>
                            ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={resetState}>
                {t("common.back", "Back")}
              </Button>
              <Button onClick={handleImport} disabled={mappedCount === 0}>
                <Upload className="mr-1.5 size-3.5" />
                {t("import.importButton", "Import {{count}} rows", { count: fileRows.length })}
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* ── Importing phase ──────────────────────────────── */}
        {phase === "importing" && (
          <div className="space-y-4 py-6">
            <div className="text-center text-sm text-muted-foreground">
              {t("import.importing", "Importing records...")}
            </div>
            {/* Progress bar */}
            <div className="mx-auto w-full max-w-md">
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="mt-2 text-center text-xs text-muted-foreground">{progress}%</p>
            </div>
          </div>
        )}

        {/* ── Done phase ───────────────────────────────────── */}
        {phase === "done" && result && (
          <div className="space-y-4">
            {/* Summary */}
            <div className="flex flex-col items-center gap-3 py-4">
              {result.imported > 0 ? (
                <CheckCircle2 className="size-10 text-green-500" />
              ) : (
                <AlertCircle className="size-10 text-destructive" />
              )}
              <div className="text-center">
                <p className="text-sm font-medium">
                  {t("import.summaryImported", "{{count}} record(s) imported successfully", {
                    count: result.imported,
                  })}
                </p>
                {result.errors.length > 0 && (
                  <p className="mt-1 text-sm text-destructive">
                    {t("import.summaryFailed", "{{count}} row(s) failed", {
                      count: result.errors.length,
                    })}
                  </p>
                )}
              </div>
            </div>

            {/* Error details */}
            {result.errors.length > 0 && (
              <div>
                <button
                  type="button"
                  className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                  onClick={() => setErrorsExpanded(!errorsExpanded)}
                >
                  {errorsExpanded ? (
                    <ChevronDown className="size-3.5" />
                  ) : (
                    <ChevronRight className="size-3.5" />
                  )}
                  {t("import.errorDetails", "Error details")}
                </button>
                {errorsExpanded && (
                  <div className="mt-2 max-h-48 overflow-y-auto rounded border border-border">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b bg-muted/50">
                          <th className="px-2 py-1.5 text-left font-medium w-16">
                            {t("import.errorRow", "Row")}
                          </th>
                          <th className="px-2 py-1.5 text-left font-medium">
                            {t("import.errorMessage", "Error")}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.errors.map((err, i) => (
                          <tr key={`err-${i}`} className="border-b last:border-0">
                            <td className="px-2 py-1.5 text-muted-foreground">{err.row}</td>
                            <td className="px-2 py-1.5 text-destructive">{err.error}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                {t("common.close", "Close")}
              </Button>
              {result.imported > 0 && (
                <Button
                  onClick={() => {
                    handleOpenChange(false);
                    onImported?.();
                  }}
                >
                  {t("common.ok", "OK")}
                </Button>
              )}
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
