/**
 * ManyToMany widget — Display and input components for many_to_many relationship fields.
 *
 * Display: Shows related records as chips/tags.
 * Input: Multi-select combobox for selecting multiple related records.
 */

import {
  Badge,
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@linchkit/ui-kit/components";
import { cn } from "@linchkit/ui-kit/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSchemaBundle } from "@/hooks/use-entity-bundle";
import { queryList } from "@/lib/api";
import type { WidgetDisplayProps, WidgetInputProps } from "@/lib/widget-registry";
import { getRecordLabel, type RelatedRecord } from "./relation-utils";

export function ManyToManyDisplay({ value, fieldDef }: WidgetDisplayProps) {
  const { t } = useTranslation();
  const targetSchema = (fieldDef as { target?: string }).target ?? "";
  const { bundle: targetBundle } = useSchemaBundle(targetSchema);
  const titleField = targetBundle?.schema.presentation?.titleField;

  // If value is already an array of expanded objects (server-side resolution)
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-muted-foreground">--</span>;
    }
    const displayItems = value.slice(0, 3) as RelatedRecord[];
    const remaining = value.length - displayItems.length;

    return (
      <div className="flex flex-wrap items-center gap-1">
        {displayItems.map((item, i) => (
          <Badge key={item.id ?? i} variant="secondary" className="text-xs">
            {getRecordLabel(item, titleField)}
          </Badge>
        ))}
        {remaining > 0 && (
          <Badge variant="outline" className="text-xs">
            +{remaining}
          </Badge>
        )}
      </div>
    );
  }

  // If value is a number (count)
  if (typeof value === "number") {
    return (
      <Badge variant="secondary" className="text-xs">
        {t("common.item", { count: value })}
      </Badge>
    );
  }

  // No data available
  return <span className="text-muted-foreground">--</span>;
}

export function ManyToManyInput({
  value,
  onChange,
  onBlur,
  readonly,
  error,
  dirty,
  fieldDef,
}: WidgetInputProps) {
  const { t } = useTranslation();
  const targetSchema = (fieldDef as { target?: string }).target ?? "";
  const { bundle: targetBundle } = useSchemaBundle(targetSchema);
  const titleField = targetBundle?.schema.presentation?.titleField;
  const [open, setOpen] = useState(false);

  // Determine which fields to fetch
  const FALLBACK_FIELDS = ["name", "title", "label", "displayName", "display_name"];
  const fetchFields = titleField ? ["id", titleField] : ["id", ...FALLBACK_FIELDS];

  // Fetch all candidate records for the target schema
  const { data: allRecords, isLoading } = useQuery<RelatedRecord[]>({
    queryKey: ["m2m-records", targetSchema, fetchFields.join(",")],
    queryFn: async () => {
      const result = await queryList<RelatedRecord>({
        schema: targetSchema,
        fields: fetchFields,
        pageSize: 100,
      });
      return result.items;
    },
    enabled: !!targetSchema && !readonly,
  });

  // Selected IDs — value can be an array of IDs or an array of expanded objects
  const selectedIds: string[] = (() => {
    if (!Array.isArray(value)) return [];
    return value.map((v: unknown) => {
      if (typeof v === "string") return v;
      if (v && typeof v === "object" && "id" in v) return String((v as RelatedRecord).id);
      return String(v);
    });
  })();

  // Selected records (resolved from allRecords or from value if expanded)
  const selectedRecords: RelatedRecord[] = (() => {
    if (!Array.isArray(value)) return [];
    // If value contains expanded objects, use them directly
    if (value.length > 0 && typeof value[0] === "object" && value[0] !== null) {
      return value as RelatedRecord[];
    }
    // Otherwise resolve from allRecords
    if (!allRecords) return [];
    return allRecords.filter((r) => selectedIds.includes(r.id));
  })();

  const handleToggle = useCallback(
    (recordId: string) => {
      const newIds = selectedIds.includes(recordId)
        ? selectedIds.filter((id) => id !== recordId)
        : [...selectedIds, recordId];
      onChange(newIds);
    },
    [selectedIds, onChange],
  );

  const handleRemove = useCallback(
    (recordId: string) => {
      onChange(selectedIds.filter((id) => id !== recordId));
    },
    [selectedIds, onChange],
  );

  if (readonly) {
    return (
      <div className="space-y-1">
        {selectedRecords.length === 0 ? (
          <span className="text-sm text-muted-foreground">{t("common.none", "None")}</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {selectedRecords.map((record, i) => (
              <Badge key={record.id ?? i} variant="secondary" className="text-xs">
                {getRecordLabel(record, titleField)}
              </Badge>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Selected items as removable chips */}
      {selectedRecords.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selectedRecords.map((record, i) => (
            <Badge key={record.id ?? i} variant="secondary" className="gap-1 text-xs">
              {getRecordLabel(record, titleField)}
              <button
                type="button"
                className="ml-0.5 rounded-full text-muted-foreground hover:text-foreground"
                onClick={() => handleRemove(record.id)}
              >
                x
              </button>
            </Badge>
          ))}
        </div>
      )}

      {/* Multi-select combobox */}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(
              "w-full justify-start text-left font-normal",
              dirty && !error && "border-ring",
              error && "border-destructive",
            )}
            onBlur={onBlur}
          >
            {isLoading
              ? t("common.loading", "Loading...")
              : t("common.selectTarget", "Select {{target}}...", {
                  target: targetBundle?.schema.label ?? targetSchema,
                })}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[300px] p-0" align="start">
          <Command>
            <CommandInput placeholder={`${t("common.search", "Search")}...`} />
            <CommandList>
              <CommandEmpty>{t("commandPalette.noResults", "No results found.")}</CommandEmpty>
              <CommandGroup>
                {(allRecords ?? []).map((record) => {
                  const isSelected = selectedIds.includes(record.id);
                  return (
                    <CommandItem
                      key={record.id}
                      value={getRecordLabel(record, titleField)}
                      onSelect={() => handleToggle(record.id)}
                    >
                      <span
                        className={cn(
                          "mr-2 flex size-4 items-center justify-center rounded-sm border",
                          isSelected ? "bg-primary text-primary-foreground" : "opacity-50",
                        )}
                      >
                        {isSelected && <Check className="h-3 w-3" />}
                      </span>
                      {getRecordLabel(record, titleField)}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
