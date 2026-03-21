/**
 * Shared field rendering utilities for auto-generated views.
 *
 * FieldDisplay — renders a field value for read-only display (used in list/detail).
 * FieldInput  — renders a field input for forms.
 */

import type { FieldDefinition, EnumField } from "@linchkit/core";
import type { ViewFieldConfig } from "@linchkit/core";
import { cn } from "../lib/utils";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Switch } from "./ui/switch";
import { Badge } from "./ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Label } from "./ui/label";

// ── Display component ─────────────────────────────────────

interface FieldDisplayProps {
  field: ViewFieldConfig;
  value: unknown;
  fieldDef: FieldDefinition;
}

/** Map state values to badge variants for colored display */
const STATE_VARIANT_MAP: Record<string, "default" | "secondary" | "destructive" | "success" | "warning" | "info"> = {
  draft: "secondary",
  pending: "warning",
  submitted: "info",
  approved: "success",
  rejected: "destructive",
  completed: "success",
  cancelled: "secondary",
  active: "success",
  inactive: "secondary",
};

function getStateVariant(value: string): "default" | "secondary" | "destructive" | "success" | "warning" | "info" {
  return STATE_VARIANT_MAP[value.toLowerCase()] ?? "default";
}

/** Render a field value for read-only display (list cells, detail views). */
export function FieldDisplay({ field: _field, value, fieldDef }: FieldDisplayProps) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">&mdash;</span>;
  }

  switch (fieldDef.type) {
    case "string":
      return <span className="truncate">{String(value)}</span>;

    case "text":
      return (
        <span className="truncate max-w-xs block" title={String(value)}>
          {String(value)}
        </span>
      );

    case "number": {
      const formatted = fieldDef.ui?.format === "currency"
        ? formatCurrency(Number(value))
        : Number(value).toLocaleString();
      return <span className="tabular-nums text-right block">{formatted}</span>;
    }

    case "boolean":
      return <span className="text-sm">{value ? "Yes" : "No"}</span>;

    case "date":
      return <span>{formatDate(value)}</span>;

    case "datetime":
      return <span>{formatDateTime(value)}</span>;

    case "enum": {
      const enumDef = fieldDef as EnumField;
      const option = enumDef.options?.find((o) => o.value === value);
      const label = option?.label ?? String(value);
      return <Badge variant="outline">{label}</Badge>;
    }

    case "state":
      return (
        <Badge variant={getStateVariant(String(value))}>
          {String(value)}
        </Badge>
      );

    case "ref":
      return <span className="font-mono text-xs text-muted-foreground">{String(value)}</span>;

    case "json":
      return <span className="text-xs text-muted-foreground">[JSON]</span>;

    case "computed":
      return <span>{String(value)}</span>;

    default:
      return <span>{String(value)}</span>;
  }
}

// ── Input component ────────────────────────────────────────

export interface FieldInputProps {
  field: ViewFieldConfig;
  value: unknown;
  fieldDef: FieldDefinition;
  onChange: (value: unknown) => void;
  onBlur?: () => void;
  readonly?: boolean;
  error?: string;
  dirty?: boolean;
}

/** Render a form input for a field. */
export function FieldInput({
  field: _field,
  value,
  fieldDef,
  onChange,
  onBlur,
  readonly,
  error,
  dirty,
}: FieldInputProps) {
  const disabled = readonly;
  const placeholder = fieldDef.description ?? (fieldDef.label ? `Enter ${fieldDef.label.toLowerCase()}` : undefined);

  switch (fieldDef.type) {
    case "string":
      return (
        <div className="space-y-1">
          <div className="relative">
            <Input
              type="text"
              value={value != null ? String(value) : ""}
              onChange={(e) => onChange(e.target.value)}
              onBlur={onBlur}
              disabled={disabled}
              placeholder={placeholder}
              aria-invalid={!!error}
              className={cn(dirty && !error && "border-blue-300")}
            />
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      );

    case "text":
      return (
        <div className="space-y-1">
          <Textarea
            value={value != null ? String(value) : ""}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onBlur}
            disabled={disabled}
            placeholder={placeholder}
            aria-invalid={!!error}
            className={cn(dirty && !error && "border-blue-300")}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      );

    case "number":
      return (
        <div className="space-y-1">
          <Input
            type="number"
            className={cn("tabular-nums", dirty && !error && "border-blue-300")}
            value={value != null ? Number(value) : ""}
            onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
            onBlur={onBlur}
            disabled={disabled}
            placeholder={placeholder ?? "0"}
            aria-invalid={!!error}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      );

    case "boolean":
      return (
        <div className="space-y-1">
          <div className="flex items-center gap-2 pt-1">
            <Switch
              checked={Boolean(value)}
              onCheckedChange={(checked) => onChange(checked)}
              disabled={disabled}
            />
            <span className="text-sm text-muted-foreground">
              {value ? "Yes" : "No"}
            </span>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      );

    case "date":
      return (
        <div className="space-y-1">
          <Input
            type="date"
            value={value != null ? toDateInputValue(value) : ""}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onBlur}
            disabled={disabled}
            aria-invalid={!!error}
            className={cn(dirty && !error && "border-blue-300")}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      );

    case "datetime":
      return (
        <div className="space-y-1">
          <Input
            type="datetime-local"
            value={value != null ? toDateTimeInputValue(value) : ""}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onBlur}
            disabled={disabled}
            aria-invalid={!!error}
            className={cn(dirty && !error && "border-blue-300")}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      );

    case "enum": {
      const enumDef = fieldDef as EnumField;
      return (
        <div className="space-y-1">
          <Select
            value={value != null ? String(value) : undefined}
            onValueChange={(val) => onChange(val)}
            disabled={disabled}
          >
            <SelectTrigger
              className={cn(
                dirty && !error && "border-blue-300",
                error && "border-destructive",
              )}
              onBlur={onBlur}
            >
              <SelectValue placeholder="Select..." />
            </SelectTrigger>
            <SelectContent>
              {enumDef.options?.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label ?? opt.value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      );
    }

    case "state":
      return (
        <div className="pt-1">
          <Badge variant={getStateVariant(value != null ? String(value) : "")}>
            {value != null ? String(value) : "—"}
          </Badge>
        </div>
      );

    case "ref":
      return (
        <div className="space-y-1">
          <Select
            value={value != null ? String(value) : undefined}
            onValueChange={(val) => onChange(val)}
            disabled={disabled}
          >
            <SelectTrigger
              className={cn(
                "font-mono text-xs",
                dirty && !error && "border-blue-300",
                error && "border-destructive",
              )}
              onBlur={onBlur}
            >
              <SelectValue placeholder="Select reference..." />
            </SelectTrigger>
            <SelectContent>
              {/* Placeholder — will be wired to API later */}
              <SelectItem value="__none" disabled>
                No data available
              </SelectItem>
            </SelectContent>
          </Select>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      );

    case "json":
      return (
        <div className="space-y-1">
          <Textarea
            className={cn(
              "min-h-[120px] font-mono text-xs",
              dirty && !error && "border-blue-300",
            )}
            value={value != null ? (typeof value === "string" ? value : JSON.stringify(value, null, 2)) : ""}
            onChange={(e) => {
              try {
                onChange(JSON.parse(e.target.value));
              } catch {
                onChange(e.target.value);
              }
            }}
            onBlur={onBlur}
            disabled={disabled}
            aria-invalid={!!error}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      );

    default:
      return (
        <div className="space-y-1">
          <Input
            type="text"
            value={value != null ? String(value) : ""}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onBlur}
            disabled={disabled}
            aria-invalid={!!error}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      );
  }
}

// ── Helpers ────────────────────────────────────────────────

function formatDate(value: unknown): string {
  try {
    const d = value instanceof Date ? value : new Date(String(value));
    return d.toLocaleDateString();
  } catch {
    return String(value);
  }
}

function formatDateTime(value: unknown): string {
  try {
    const d = value instanceof Date ? value : new Date(String(value));
    return d.toLocaleString();
  } catch {
    return String(value);
  }
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

function toDateInputValue(value: unknown): string {
  try {
    const d = value instanceof Date ? value : new Date(String(value));
    return d.toISOString().split("T")[0] ?? "";
  } catch {
    return String(value);
  }
}

function toDateTimeInputValue(value: unknown): string {
  try {
    const d = value instanceof Date ? value : new Date(String(value));
    return d.toISOString().slice(0, 16);
  } catch {
    return String(value);
  }
}

// Re-export Label for use in AutoForm
export { Label };
