import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@linchkit/ui-kit/components";
import { cn } from "@linchkit/ui-kit/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useSchemaBundle } from "@/hooks/use-schema-bundle";
import { queryList } from "@/lib/api";
import type { WidgetDisplayProps, WidgetInputProps } from "@/lib/widget-registry";
import { requiredBg } from "./utils";

interface RefRecord {
  id: string;
  [key: string]: unknown;
}

/** Heuristic fallback: guess the title field from common naming patterns */
const TITLE_FIELD_CANDIDATES = ["name", "title", "label", "displayName", "display_name"];

function guessTitleField(record: RefRecord): string {
  for (const candidate of TITLE_FIELD_CANDIDATES) {
    if (candidate in record) return candidate;
  }
  return "id";
}

/** Resolve display label from a ref record */
function getRecordLabel(record: RefRecord, titleField: string | undefined): string {
  if (titleField && titleField in record) {
    return String(record[titleField] ?? record.id);
  }
  const guessed = guessTitleField(record);
  return String(record[guessed] ?? record.id);
}

export function RefDisplay({ value, fieldDef }: WidgetDisplayProps) {
  const targetSchema = (fieldDef as { target?: string }).target ?? "";
  const { bundle } = useSchemaBundle(targetSchema);

  if (value == null) return <span className="text-muted-foreground">—</span>;
  const titleField = bundle?.schema.presentation?.titleField;

  // If value is an expanded object with display field
  if (typeof value === "object" && value !== null && "id" in value) {
    const record = value as RefRecord;
    return <span>{getRecordLabel(record, titleField)}</span>;
  }

  // Fallback: show raw ID
  return <span className="font-mono text-xs text-muted-foreground">{String(value)}</span>;
}

export function RefInput({
  value,
  onChange,
  onBlur,
  readonly,
  error,
  dirty,
  required,
  fieldDef,
}: WidgetInputProps) {
  const { t } = useTranslation();
  const targetSchema = (fieldDef as { target?: string }).target ?? "";

  // Fetch target schema bundle to resolve titleField
  const { bundle } = useSchemaBundle(targetSchema);
  const titleField = bundle?.schema.presentation?.titleField;

  // Determine which fields to fetch: id + titleField (or heuristic candidates)
  const fetchFields = titleField ? ["id", titleField] : ["id", ...TITLE_FIELD_CANDIDATES];

  const {
    data,
    isLoading,
    error: queryError,
  } = useQuery<RefRecord[]>({
    queryKey: ["ref-records", targetSchema, fetchFields.join(",")],
    queryFn: async () => {
      const result = await queryList<RefRecord>({
        schema: targetSchema,
        fields: fetchFields,
        pageSize: 100,
      });
      return result.items;
    },
    enabled: !!targetSchema && !readonly,
  });

  const options = (data ?? []).map((record) => ({
    value: record.id,
    label: getRecordLabel(record, titleField),
  }));

  return (
    <div className="space-y-1">
      <Select
        value={value != null ? String(value) : undefined}
        onValueChange={(val) => onChange(val)}
        disabled={readonly || isLoading}
      >
        <SelectTrigger
          className={cn(
            "w-full",
            required && requiredBg,
            dirty && !error && "border-ring",
            error && "border-destructive focus-visible:ring-destructive",
          )}
          onBlur={onBlur}
        >
          <SelectValue
            placeholder={
              isLoading ? t("common.loading", "Loading...") : t("common.select", "Select...")
            }
          />
        </SelectTrigger>
        <SelectContent>
          {queryError && (
            <div className="px-2 py-1 text-xs text-destructive">
              {t("common.loadFailed", "Failed to load options")}
            </div>
          )}
          {options.length === 0 && !isLoading && !queryError && (
            <SelectItem value="__empty" disabled>
              {t("common.noOptions", "No options available")}
            </SelectItem>
          )}
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
