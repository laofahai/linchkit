/**
 * Ref widget — Display and input for many_to_one / ref relationship fields.
 *
 * Features:
 * - Select from existing records
 * - Quick create: type a name not in the list, select "Create: xxx" to add a virtual record
 * - Create & Edit: open a Dialog with AutoForm to fill in more fields for the new record
 * - Virtual records get a _virtual_ prefixed temp ID, persisted on parent form save
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
  CommandSeparator,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@linchkit/ui-kit/components";
import { cn } from "@linchkit/ui-kit/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, PlusCircle } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useEntityBundle } from "@/hooks/use-entity-bundle";
import { useEntityLabel } from "@/i18n/use-entity-label";
import { queryList } from "@/lib/entity-api";
import type { WidgetDisplayProps, WidgetInputProps } from "@/lib/widget-registry";
import type { RelatedRecord } from "./relation-utils";
import { requiredBg } from "./utils";

/** Heuristic fallback: guess the title field from common naming patterns */
const TITLE_FIELD_CANDIDATES = ["name", "title", "label", "displayName", "display_name"];

function guessTitleField(record: RelatedRecord): string {
  for (const candidate of TITLE_FIELD_CANDIDATES) {
    if (candidate in record) return candidate;
  }
  return "id";
}

/** Resolve display label from a ref record */
function getRefRecordLabel(record: RelatedRecord, titleField: string | undefined): string {
  if (titleField && titleField in record) {
    return String(record[titleField] ?? record.id);
  }
  const guessed = guessTitleField(record);
  return String(record[guessed] ?? record.id);
}

/** Generate a virtual temporary ID */
function generateTempId(): string {
  return `_virtual_${crypto.randomUUID()}`;
}

export function RefDisplay({ value, fieldDef }: WidgetDisplayProps) {
  const targetSchema = (fieldDef as { target?: string }).target ?? "";
  const { bundle } = useEntityBundle(targetSchema);

  if (value == null) return <span className="text-muted-foreground">--</span>;
  const titleField = bundle?.schema.presentation?.titleField;

  // If value is an expanded object with display field
  if (typeof value === "object" && value !== null && "id" in value) {
    const record = value as RelatedRecord;
    const isVirtual = typeof record.id === "string" && record.id.startsWith("_virtual_");
    return (
      <span>
        {getRefRecordLabel(record, titleField)}
        {isVirtual && (
          <Badge variant="outline" className="ml-1.5 text-[10px] px-1 py-0">
            new
          </Badge>
        )}
      </span>
    );
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
  const { bundle } = useEntityBundle(targetSchema);
  const titleField = bundle?.schema.presentation?.titleField;

  // Determine which fields to fetch: id + titleField (or heuristic candidates)
  const fetchFields = titleField ? ["id", titleField] : ["id", ...TITLE_FIELD_CANDIDATES];

  const {
    data,
    isLoading,
    error: queryError,
  } = useQuery<RelatedRecord[]>({
    queryKey: ["ref-records", targetSchema, fetchFields.join(",")],
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

  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [quickCreateDialogOpen, setQuickCreateDialogOpen] = useState(false);
  const [quickCreateName, setQuickCreateName] = useState("");
  const quickCreateFormRef = useRef<Record<string, unknown>>({});

  const options = useMemo(
    () =>
      (data ?? []).map((record) => ({
        value: record.id,
        label: getRefRecordLabel(record, titleField),
      })),
    [data, titleField],
  );

  // Check if the current search query matches any existing option
  const searchMatchesExisting = useMemo(() => {
    if (!searchQuery.trim()) return true;
    const lower = searchQuery.toLowerCase().trim();
    return options.some((opt) => opt.label.toLowerCase().includes(lower));
  }, [searchQuery, options]);

  // Resolve the currently selected label
  const selectedLabel = useMemo(() => {
    if (value == null || value === "") return null;

    // Check if value is a virtual record object
    if (typeof value === "object" && value !== null && "id" in value) {
      const record = value as RelatedRecord;
      return getRefRecordLabel(record, titleField);
    }

    // Resolve from fetched options
    const selectedId = String(value);
    const opt = options.find((o) => o.value === selectedId);
    return opt?.label ?? null;
  }, [value, options, titleField]);

  const handleSelect = useCallback(
    (selectedValue: string) => {
      // If already selected, deselect
      const currentId =
        typeof value === "object" && value !== null && "id" in value
          ? String((value as RelatedRecord).id)
          : value != null
            ? String(value)
            : "";
      if (selectedValue === currentId) {
        onChange(null);
      } else {
        onChange(selectedValue);
      }
      setOpen(false);
      setSearchQuery("");
    },
    [value, onChange],
  );

  /** Quick create: create a virtual record with just the name */
  const handleQuickCreate = useCallback(
    (name: string) => {
      const nameField = titleField ?? "name";
      const virtualRecord: RelatedRecord = {
        id: generateTempId(),
        _virtual: true,
        [nameField]: name,
      };
      onChange(virtualRecord);
      setOpen(false);
      setSearchQuery("");
    },
    [titleField, onChange],
  );

  /** Open create-and-edit dialog */
  const handleOpenCreateAndEdit = useCallback(
    (name: string) => {
      setQuickCreateName(name);
      const nameField = titleField ?? "name";
      quickCreateFormRef.current = { [nameField]: name };
      setOpen(false);
      setSearchQuery("");
      setQuickCreateDialogOpen(true);
    },
    [titleField],
  );

  /** Confirm create-and-edit dialog */
  const handleConfirmCreateAndEdit = useCallback(() => {
    const nameField = titleField ?? "name";
    const formValues = quickCreateFormRef.current;
    const virtualRecord: RelatedRecord = {
      id: generateTempId(),
      _virtual: true,
      ...formValues,
    };
    // Ensure the name field has a value
    if (!virtualRecord[nameField]) {
      virtualRecord[nameField] = quickCreateName;
    }
    onChange(virtualRecord);
    setQuickCreateDialogOpen(false);
    setQuickCreateName("");
    quickCreateFormRef.current = {};
  }, [titleField, quickCreateName, onChange]);

  const { resolveLabel } = useEntityLabel();

  // Resolve editable fields for create-and-edit dialog
  const dialogFields = useMemo(() => {
    if (!bundle?.schema?.fields) return [];
    const systemFields = new Set([
      "id",
      "tenant_id",
      "created_at",
      "updated_at",
      "created_by",
      "updated_by",
      "_version",
      "is_deleted",
    ]);
    return Object.entries(bundle.schema.fields)
      .filter(([name, def]) => {
        if (systemFields.has(name)) return false;
        const fieldType = (def as { type?: string }).type;
        if (fieldType === "state" || fieldType === "computed") return false;
        if ((def as { derived?: unknown }).derived) return false;
        // Relation fields are now managed via defineRelation(), skip non-input types
        return true;
      })
      .map(([name, def]) => ({
        name,
        label: resolveLabel((def as { label?: string }).label, name),
        type: (def as { type?: string }).type ?? "string",
        required: !!(def as { required?: boolean }).required,
        options: (def as { options?: Array<{ value: string; label?: string }> }).options,
      }));
  }, [bundle, resolveLabel]);

  // Count required fields (excluding titleField) to determine if quick create is safe
  const requiredFieldCount = useMemo(() => {
    return dialogFields.filter((f) => f.required).length;
  }, [dialogFields]);

  // Only allow quick create (name-only) if there's at most 1 required field (the title itself)
  const allowQuickCreate = requiredFieldCount <= 1;

  if (readonly) {
    return (
      <div className="space-y-1">
        <div className="text-sm text-muted-foreground">{selectedLabel ?? "--"}</div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className={cn(
              "w-full justify-between font-normal h-9",
              required && requiredBg,
              dirty && !error && "border-ring",
              error && "border-destructive focus-visible:ring-destructive",
              !selectedLabel && "text-muted-foreground",
            )}
            onBlur={onBlur}
          >
            <span className="truncate">
              {isLoading
                ? t("common.loading", "Loading...")
                : (selectedLabel ?? t("common.select", "Select..."))}
            </span>
            <ChevronsUpDown className="ml-2 size-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[300px] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder={`${t("common.search", "Search")}...`}
              value={searchQuery}
              onValueChange={setSearchQuery}
            />
            <CommandList>
              {queryError && (
                <div className="px-2 py-1 text-xs text-destructive">
                  {t("common.loadFailed", "Failed to load options")}
                </div>
              )}

              <CommandEmpty>
                {searchQuery.trim() ? (
                  <div className="text-sm text-muted-foreground">
                    {t("widget.refNoResults", "No results found.")}
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">
                    {t("common.noOptions", "No options available")}
                  </div>
                )}
              </CommandEmpty>

              <CommandGroup>
                {options
                  .filter((opt) => {
                    if (!searchQuery.trim()) return true;
                    return opt.label.toLowerCase().includes(searchQuery.toLowerCase().trim());
                  })
                  .map((opt) => {
                    const currentId =
                      typeof value === "object" && value !== null && "id" in value
                        ? String((value as RelatedRecord).id)
                        : value != null
                          ? String(value)
                          : "";
                    const isSelected = opt.value === currentId;
                    return (
                      <CommandItem
                        key={opt.value}
                        value={opt.label}
                        onSelect={() => handleSelect(opt.value)}
                      >
                        <Check
                          className={cn("mr-2 size-3.5", isSelected ? "opacity-100" : "opacity-0")}
                        />
                        {opt.label}
                      </CommandItem>
                    );
                  })}
              </CommandGroup>

              {/* Quick create options — shown when search query doesn't match existing records */}
              {searchQuery.trim() && !searchMatchesExisting && (
                <>
                  <CommandSeparator />
                  <CommandGroup>
                    {allowQuickCreate && (
                      <CommandItem
                        onSelect={() => handleQuickCreate(searchQuery.trim())}
                        className="gap-2"
                      >
                        <PlusCircle className="size-3.5" />
                        {t("widget.quickCreate", 'Create "{{name}}"', {
                          name: searchQuery.trim(),
                        })}
                      </CommandItem>
                    )}
                    <CommandItem
                      onSelect={() => handleOpenCreateAndEdit(searchQuery.trim())}
                      className="gap-2"
                    >
                      <PlusCircle className="size-3.5" />
                      {t("widget.createAndEdit", 'Create and edit "{{name}}"', {
                        name: searchQuery.trim(),
                      })}
                    </CommandItem>
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      {/* Virtual record indicator */}
      {typeof value === "object" &&
        value !== null &&
        "id" in value &&
        typeof (value as RelatedRecord).id === "string" &&
        (value as RelatedRecord).id.startsWith("_virtual_") && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            {t("widget.virtualRecordHint", "New record -- will be created on save")}
          </p>
        )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      {/* Create-and-edit dialog */}
      <QuickCreateDialog
        open={quickCreateDialogOpen}
        onOpenChange={setQuickCreateDialogOpen}
        fields={dialogFields}
        initialName={quickCreateName}
        titleField={titleField ?? "name"}
        targetLabel={resolveLabel(bundle?.schema.label, targetSchema)}
        formRef={quickCreateFormRef}
        onConfirm={handleConfirmCreateAndEdit}
      />
    </div>
  );
}

// ── Quick create dialog ──────────────────────────────────────────

interface QuickCreateDialogField {
  name: string;
  label: string;
  type: string;
  required: boolean;
  options?: Array<{ value: string; label?: string }>;
}

interface QuickCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fields: QuickCreateDialogField[];
  initialName: string;
  titleField: string;
  targetLabel: string;
  formRef: React.MutableRefObject<Record<string, unknown>>;
  onConfirm: () => void;
}

function QuickCreateDialog({
  open,
  onOpenChange,
  fields,
  initialName,
  titleField,
  targetLabel,
  formRef,
  onConfirm,
}: QuickCreateDialogProps) {
  const { t } = useTranslation();
  const [formState, setFormState] = useState<Record<string, unknown>>({});

  // Initialize form state when dialog opens
  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (isOpen) {
        const initial: Record<string, unknown> = { [titleField]: initialName };
        for (const field of fields) {
          if (field.name !== titleField) {
            initial[field.name] = "";
          }
        }
        setFormState(initial);
        formRef.current = initial;
      }
      onOpenChange(isOpen);
    },
    [fields, initialName, titleField, formRef, onOpenChange],
  );

  const handleFieldChange = useCallback(
    (fieldName: string, value: unknown) => {
      setFormState((prev) => {
        const next = { ...prev, [fieldName]: value };
        formRef.current = next;
        return next;
      });
    },
    [formRef],
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("widget.createNewRecord", "Create {{target}}", { target: targetLabel })}
          </DialogTitle>
          <DialogDescription>
            {t(
              "widget.createAndEditDescription",
              "Fill in the details for the new record. It will be saved when you save the parent form.",
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          {fields.map((field) => {
            const fieldId = `qc-${field.name}`;
            return (
              <div key={field.name} className="space-y-1">
                <label htmlFor={fieldId} className="text-sm font-medium text-muted-foreground">
                  {field.label}
                  {field.required && <span className="text-destructive ml-0.5">*</span>}
                </label>
                {field.type === "enum" && field.options ? (
                  <select
                    id={fieldId}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={formState[field.name] != null ? String(formState[field.name]) : ""}
                    onChange={(e) => handleFieldChange(field.name, e.target.value)}
                  >
                    <option value="">--</option>
                    {field.options.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label ?? opt.value}
                      </option>
                    ))}
                  </select>
                ) : field.type === "boolean" ? (
                  <input
                    id={fieldId}
                    type="checkbox"
                    checked={!!formState[field.name]}
                    onChange={(e) => handleFieldChange(field.name, e.target.checked)}
                    className="ml-1"
                  />
                ) : field.type === "number" ? (
                  <input
                    id={fieldId}
                    type="number"
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={formState[field.name] != null ? String(formState[field.name]) : ""}
                    onChange={(e) =>
                      handleFieldChange(
                        field.name,
                        e.target.value === "" ? null : Number(e.target.value),
                      )
                    }
                  />
                ) : (
                  <input
                    id={fieldId}
                    type="text"
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={formState[field.name] != null ? String(formState[field.name]) : ""}
                    onChange={(e) => handleFieldChange(field.name, e.target.value)}
                  />
                )}
              </div>
            );
          })}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel", "Cancel")}
          </Button>
          <Button type="button" onClick={onConfirm}>
            {t("common.create", "Create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
