import type { ComparisonOperator } from "@linchkit/core/types";
import type { LucideIcon } from "lucide-react";

/*
 * # GENERAL NOTES:
 *
 * ## GENERICS:
 *
 * TData is the shape of a single row in your data table.
 * TVal is the shape of the underlying value for a column.
 * TType is the type (kind) of the column.
 *
 */

export type ElementType<T> = T extends (infer U)[] ? U : T;

export type Nullable<T> = T | null | undefined;

/*
 * The model of a column option.
 * Used for representing underlying column values of type `option` or `multiOption`.
 */
export interface ColumnOption {
  /* The label to display for the option. */
  label: string;
  /* The internal value of the option. */
  value: string;
  /* An optional icon to display next to the label. */
  icon?: React.ReactElement | React.ElementType;
}

export interface ColumnOptionExtended extends ColumnOption {
  selected?: boolean;
  count?: number;
}

/*
 * Represents the data type (kind) of a column.
 */
export type ColumnDataType =
  /* The column value is a string that should be searchable. */
  | "text"
  | "number"
  | "date"
  /* The column value can be a single value from a list of options. */
  | "option"
  /* The column value can be zero or more values from a list of options. */
  | "multiOption";

/*
 * Represents the data type (kind) of option and multi-option columns.
 */
export type OptionBasedColumnDataType = Extract<ColumnDataType, "option" | "multiOption">;

/*
 * Maps a ColumnDataType to it's primitive type (i.e. string, number, etc.).
 */
export type ColumnDataNativeMap = {
  text: string;
  number: number;
  date: Date;
  option: string;
  multiOption: string[];
};

/*
 * Represents the value of a column filter.
 * Contigent on the filtered column's data type.
 */
export type FilterValues<T extends ColumnDataType> = Array<ElementType<ColumnDataNativeMap[T]>>;

/*
 * An accessor function for a column's data.
 * Uses the original row data as an argument.
 */
export type TAccessorFn<TData, TVal = unknown> = (data: TData) => TVal;

/*
 * Used by `option` and `multiOption` columns.
 * Transforms the underlying column value into a valid ColumnOption.
 */
export type TTransformOptionFn<TVal = unknown> = (
  value: ElementType<NonNullable<TVal>>,
) => ColumnOption;

/*
 * Used by `option` and `multiOption` columns.
 * A custom ordering function when sorting a column's options.
 */
export type TOrderFn<TVal = unknown> = (
  a: ElementType<NonNullable<TVal>>,
  b: ElementType<NonNullable<TVal>>,
) => number;

/*
 * The configuration for a column.
 */
export type ColumnConfig<
  TData,
  TType extends ColumnDataType = ColumnDataType,
  TVal = unknown,
  TId extends string = string,
> = {
  id: TId;
  accessor: TAccessorFn<TData, TVal>;
  displayName: string;
  icon: LucideIcon;
  type: TType;
  options?: TType extends OptionBasedColumnDataType ? ColumnOption[] : never;
  facetedOptions?: TType extends OptionBasedColumnDataType ? Map<string, number> : never;
  min?: TType extends "number" ? number : never;
  max?: TType extends "number" ? number : never;
  transformOptionFn?: TType extends OptionBasedColumnDataType ? TTransformOptionFn<TVal> : never;
  orderFn?: TType extends OptionBasedColumnDataType ? TOrderFn<TVal> : never;
};

export type OptionColumnId<T> =
  T extends ColumnConfig<infer _TData, "option" | "multiOption", infer _TVal, infer TId>
    ? TId
    : never;

export type OptionColumnIds<
  T extends ReadonlyArray<ColumnConfig<unknown, ColumnDataType, unknown, string>>,
> = {
  [K in keyof T]: OptionColumnId<T[K]>;
}[number];

export type NumberColumnId<T> =
  T extends ColumnConfig<infer _TData, "number", infer _TVal, infer TId> ? TId : never;

export type NumberColumnIds<
  T extends ReadonlyArray<ColumnConfig<unknown, ColumnDataType, unknown, string>>,
> = {
  [K in keyof T]: NumberColumnId<T[K]>;
}[number];

/*
 * Describes a helper function for creating column configurations.
 */
export type ColumnConfigHelper<TData> = {
  accessor: <
    TAccessor extends TAccessorFn<TData>,
    TType extends ColumnDataType,
    TVal extends ReturnType<TAccessor>,
  >(
    accessor: TAccessor,
    config?: Omit<ColumnConfig<TData, TType, TVal>, "accessor">,
  ) => ColumnConfig<TData, TType, unknown>;
};

export type DataTableFilterConfig<TData> = {
  data: TData[];
  columns: ColumnConfig<TData>[];
};

export type ColumnProperties<_TData, TVal> = {
  getOptions: () => ColumnOption[];
  getValues: () => ElementType<NonNullable<TVal>>[];
  getFacetedUniqueValues: () => Map<string, number> | undefined;
  getFacetedMinMaxValues: () => [number, number] | undefined;
  prefetchOptions: () => Promise<void>; // Prefetch options
  prefetchValues: () => Promise<void>; // Prefetch values
  prefetchFacetedUniqueValues: () => Promise<void>; // Prefetch faceted unique values
  prefetchFacetedMinMaxValues: () => Promise<void>; // Prefetch faceted min/max values
};

export type ColumnPrivateProperties<_TData, TVal> = {
  _prefetchedOptionsCache: ColumnOption[] | null;
  _prefetchedValuesCache: ElementType<NonNullable<TVal>>[] | null;
  _prefetchedFacetedUniqueValuesCache: Map<string, number> | null;
  _prefetchedFacetedMinMaxValuesCache: [number, number] | null;
};

export type Column<
  TData,
  TType extends ColumnDataType = ColumnDataType,
  TVal = unknown,
> = ColumnConfig<TData, TType, TVal> &
  ColumnProperties<TData, TVal> &
  ColumnPrivateProperties<TData, TVal>;

/*
 * Describes the available actions on column filters.
 * Includes both column-specific and global actions, ultimately acting on the column filters.
 */
export interface DataTableFilterActions {
  addFilterValue: <TData, TType extends OptionBasedColumnDataType>(
    column: Column<TData, TType>,
    values: FilterModel<TType>["values"],
  ) => void;

  removeFilterValue: <TData, TType extends OptionBasedColumnDataType>(
    column: Column<TData, TType>,
    value: FilterModel<TType>["values"],
  ) => void;

  setFilterValue: <TData, TType extends ColumnDataType>(
    column: Column<TData, TType>,
    values: FilterModel<TType>["values"],
  ) => void;

  setFilterOperator: <TType extends ColumnDataType>(
    field: string,
    operator: FilterModel<TType>["operator"],
  ) => void;

  removeFilter: (field: string) => void;

  removeAllFilters: () => void;
}

export type FilterStrategy = "client" | "server";

/* Operators for text data — using ComparisonOperator */
export type TextFilterOperator = Extract<ComparisonOperator, "contains" | "notContains">;

/* Operators for number data — using ComparisonOperator */
export type NumberFilterOperator = Extract<
  ComparisonOperator,
  "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "between" | "notBetween"
>;

/* Operators for date data — using ComparisonOperator */
export type DateFilterOperator = Extract<
  ComparisonOperator,
  "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "between" | "notBetween"
>;

/* Operators for option data — using ComparisonOperator */
export type OptionFilterOperator = Extract<ComparisonOperator, "eq" | "neq" | "in" | "not_in">;

/* Operators for multi-option data — using ComparisonOperator */
export type MultiOptionFilterOperator = Extract<
  ComparisonOperator,
  "in" | "not_in" | "includesAll" | "excludesAny"
>;

/* Maps filter operators to their respective data types */
export type FilterOperators = {
  text: TextFilterOperator;
  number: NumberFilterOperator;
  date: DateFilterOperator;
  option: OptionFilterOperator;
  multiOption: MultiOptionFilterOperator;
};

/*
 *
 * FilterModel represents a filter condition for a specific field.
 * Aligned with DeclarativeCondition format from @linchkit/core.
 *
 * It consists of:
 * - field: The field name being filtered (maps to schema field name).
 * - fieldType: The data type hint for UI rendering.
 * - operator: A ComparisonOperator value.
 * - values: The filter values (array for multi-value operators).
 *
 */
export type FilterModel<TType extends ColumnDataType = ColumnDataType> = {
  field: string;
  fieldType: TType;
  operator: FilterOperators[TType];
  values: FilterValues<TType>;
};

export type FiltersState = Array<FilterModel>;

/*
 * FilterDetails is a type that represents the details of all the filter operators for a specific column data type.
 */
export type FilterDetails<T extends ColumnDataType> = {
  [key in FilterOperators[T]]: FilterOperatorDetails<key, T>;
};

export type FilterOperatorTarget = "single" | "multiple";

export type FilterOperatorDetailsBase<OperatorValue, T extends ColumnDataType> = {
  /* The i18n key for the operator. */
  key: string;
  /* The operator value — a ComparisonOperator string. */
  value: OperatorValue;
  /* How much data the operator applies to. */
  target: FilterOperatorTarget;
  /* The plural form of the operator, if applicable. */
  singularOf?: FilterOperators[T];
  /* The singular form of the operator, if applicable. */
  pluralOf?: FilterOperators[T];
  /* All related operators. Normally, all the operators which share the same target. */
  relativeOf: FilterOperators[T] | Array<FilterOperators[T]>;
  /* Whether the operator is negated. */
  isNegated: boolean;
  /* If the operator is not negated, this provides the negated equivalent. */
  negation?: FilterOperators[T];
  /* If the operator is negated, this provides the positive equivalent. */
  negationOf?: FilterOperators[T];
};

/*
 *
 * FilterOperatorDetails is a type that provides details about a filter operator for a specific column data type.
 * It extends FilterOperatorDetailsBase with additional logic and contraints on the defined properties.
 *
 */
export type FilterOperatorDetails<
  OperatorValue,
  T extends ColumnDataType,
> = FilterOperatorDetailsBase<OperatorValue, T> &
  (
    | { singularOf?: never; pluralOf?: never }
    | { target: "single"; singularOf: FilterOperators[T]; pluralOf?: never }
    | { target: "multiple"; singularOf?: never; pluralOf: FilterOperators[T] }
  ) &
  (
    | { isNegated: false; negation: FilterOperators[T]; negationOf?: never }
    | { isNegated: true; negation?: never; negationOf: FilterOperators[T] }
  );

/* Maps column data types to their respective filter operator details */
export type FilterTypeOperatorDetails = {
  [key in ColumnDataType]: FilterDetails<key>;
};
