import {
  Button,
  Checkbox,
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
import { ArrowRightIcon, ChevronRightIcon, FilterIcon } from "lucide-react";
import React, {
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DEFAULT_OPERATORS } from "../core/operators";
import type {
  Column,
  ColumnDataType,
  DataTableFilterActions,
  FilterModel,
  FilterStrategy,
  FiltersState,
  OptionBasedColumnDataType,
} from "../core/types";
import { isAnyOf } from "../lib/array";
import { getColumn } from "../lib/helpers";
import { type Locale, t } from "../lib/i18n";
import { FilterValueController } from "./filter-value";

interface FilterSelectorProps<TData> {
  filters: FiltersState;
  columns: Column<TData>[];
  actions: DataTableFilterActions;
  strategy: FilterStrategy;
  locale?: Locale;
}

export const FilterSelector = memo(FilterSelectorInner) as typeof FilterSelectorInner;

function FilterSelectorInner<TData>({
  filters,
  columns,
  actions,
  strategy,
  locale = "en",
}: FilterSelectorProps<TData>) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [property, setProperty] = useState<string | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);

  const column = property ? getColumn(columns, property) : undefined;
  const filter = property ? filters.find((f) => f.field === property) : undefined;

  useEffect(() => {
    if (property && inputRef) {
      inputRef.current?.focus();
      setValue("");
    }
  }, [property]);

  useEffect(() => {
    if (!open) setTimeout(() => setValue(""), 150);
  }, [open]);

  // Build a default filter if one doesn't exist for the selected property
  const effectiveFilter = useMemo(() => {
    if (filter) return filter;
    if (!property || !column) return undefined;
    const columnType = column.type as ColumnDataType;
    return {
      field: property,
      fieldType: columnType,
      operator: DEFAULT_OPERATORS[columnType].single,
      values: [],
    } as FilterModel;
  }, [filter, property, column]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: need filters to be updated
  const content = useMemo(
    () =>
      property && column && effectiveFilter ? (
        <FilterValueController
          filter={effectiveFilter}
          column={column as Column<TData, ColumnDataType>}
          actions={actions}
          strategy={strategy}
          locale={locale}
        />
      ) : (
        <Command
          loop
          filter={(value, search, keywords) => {
            const extendValue = `${value} ${keywords?.join(" ")}`;
            return extendValue.toLowerCase().includes(search.toLowerCase()) ? 1 : 0;
          }}
        >
          <CommandInput
            value={value}
            onValueChange={setValue}
            ref={inputRef}
            placeholder={t("search", locale)}
          />
          <CommandEmpty>{t("noresults", locale)}</CommandEmpty>
          <CommandList className="max-h-fit">
            <CommandGroup>
              {columns.map((column) => (
                <FilterableColumn key={column.id} column={column} setProperty={setProperty} />
              ))}
              <QuickSearchFilters
                search={value}
                filters={filters}
                columns={columns}
                actions={actions}
              />
            </CommandGroup>
          </CommandList>
        </Command>
      ),
    [property, column, effectiveFilter, filters, columns, actions, value],
  );

  return (
    <Popover
      open={open}
      onOpenChange={async (value) => {
        setOpen(value);
        if (!value) setTimeout(() => setProperty(undefined), 100);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
        >
          <FilterIcon className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        className="w-fit p-0 origin-(--radix-popover-content-transform-origin)"
      >
        {content}
      </PopoverContent>
    </Popover>
  );
}

export function FilterableColumn<TData, TType extends ColumnDataType, TVal>({
  column,
  setProperty,
}: {
  column: Column<TData, TType, TVal>;
  setProperty: (value: string) => void;
}) {
  const itemRef = useRef<HTMLDivElement>(null);

  const prefetch = useCallback(() => {
    column.prefetchOptions();
    column.prefetchValues();
    column.prefetchFacetedUniqueValues();
    column.prefetchFacetedMinMaxValues();
  }, [column]);

  useEffect(() => {
    const target = itemRef.current;

    if (!target) return;

    // Set up MutationObserver
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes") {
          const isSelected = target.getAttribute("data-selected") === "true";
          if (isSelected) prefetch();
        }
      }
    });

    // Set up observer
    observer.observe(target, {
      attributes: true,
      attributeFilter: ["data-selected"],
    });

    // Cleanup on unmount
    return () => observer.disconnect();
  }, [prefetch]);

  return (
    <CommandItem
      ref={itemRef}
      value={column.id}
      keywords={[column.displayName]}
      onSelect={() => setProperty(column.id)}
      className="group"
      onMouseEnter={prefetch}
    >
      <div className="flex w-full items-center justify-between">
        <div className="inline-flex items-center gap-1.5">
          {<column.icon strokeWidth={2.25} className="size-4" />}
          <span>{column.displayName}</span>
        </div>
        <ArrowRightIcon className="size-4 opacity-0 group-aria-selected:opacity-100" />
      </div>
    </CommandItem>
  );
}

interface QuickSearchFiltersProps<TData> {
  search?: string;
  filters: FiltersState;
  columns: Column<TData>[];
  actions: DataTableFilterActions;
}

export const QuickSearchFilters = memo(QuickSearchFiltersInner) as typeof QuickSearchFiltersInner;

function QuickSearchFiltersInner<TData>({
  search,
  filters,
  columns,
  actions,
}: QuickSearchFiltersProps<TData>) {
  const cols = useMemo(
    () => columns.filter((c) => isAnyOf<ColumnDataType>(c.type, ["option", "multiOption"])),
    [columns],
  );

  if (!search || search.trim().length < 2) return null;

  return (
    <>
      {cols.map((column) => {
        const filter = filters.find((f) => f.field === column.id);
        const options = column.getOptions();
        const optionsCount = column.getFacetedUniqueValues();

        const optionColumn = column as Column<TData, OptionBasedColumnDataType>;
        function handleOptionSelect(value: string, check: boolean) {
          if (check) actions.addFilterValue(optionColumn, [value]);
          else actions.removeFilterValue(optionColumn, [value]);
        }

        return (
          <React.Fragment key={column.id}>
            {options.map((v) => {
              const checked = Boolean(filter?.values.includes(v.value));
              const count = optionsCount?.get(v.value) ?? 0;

              return (
                <CommandItem
                  key={v.value}
                  value={v.value}
                  keywords={[v.label, v.value]}
                  onSelect={() => {
                    handleOptionSelect(v.value, !checked);
                  }}
                  className="group"
                >
                  <div className="flex items-center gap-1.5 group">
                    <Checkbox
                      checked={checked}
                      className="opacity-0 data-[state=checked]:opacity-100 group-data-[selected=true]:opacity-100 dark:border-ring mr-1"
                    />
                    <div className="flex items-center w-4 justify-center">
                      {v.icon &&
                        (isValidElement(v.icon) ? (
                          v.icon
                        ) : (
                          <v.icon className="size-4 text-primary" />
                        ))}
                    </div>
                    <div className="flex items-center gap-0.5">
                      <span className="text-muted-foreground">{column.displayName}</span>
                      <ChevronRightIcon className="size-3.5 text-muted-foreground/75" />
                      <span>
                        {v.label}
                        <sup
                          className={cn(
                            !optionsCount && "hidden",
                            "ml-0.5 tabular-nums tracking-tight text-muted-foreground",
                            count === 0 && "slashed-zero",
                          )}
                        >
                          {count < 100 ? count : "100+"}
                        </sup>
                      </span>
                    </div>
                  </div>
                </CommandItem>
              );
            })}
          </React.Fragment>
        );
      })}
    </>
  );
}
