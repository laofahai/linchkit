import type {
  ColumnDataType,
  FilterDetails,
  FilterOperators,
  FilterOperatorTarget,
  FilterTypeOperatorDetails,
  FilterValues,
} from "./types";

export const DEFAULT_OPERATORS: Record<
  ColumnDataType,
  Record<FilterOperatorTarget, FilterOperators[ColumnDataType]>
> = {
  text: {
    single: "contains",
    multiple: "contains",
  },
  number: {
    single: "eq",
    multiple: "between",
  },
  date: {
    single: "eq",
    multiple: "between",
  },
  option: {
    single: "eq",
    multiple: "in",
  },
  multiOption: {
    single: "in", // multiOption always uses multi-value operators
    multiple: "in",
  },
};

/* Details for all the filter operators for option data type */
export const optionFilterOperators = {
  eq: {
    key: "operators.eq",
    value: "eq",
    target: "single",
    singularOf: "in",
    relativeOf: "neq",
    isNegated: false,
    negation: "neq",
  },
  neq: {
    key: "operators.neq",
    value: "neq",
    target: "single",
    singularOf: "not_in",
    relativeOf: "eq",
    isNegated: true,
    negationOf: "eq",
  },
  in: {
    key: "operators.in",
    value: "in",
    target: "multiple",
    pluralOf: "eq",
    relativeOf: "not_in",
    isNegated: false,
    negation: "not_in",
  },
  not_in: {
    key: "operators.not_in",
    value: "not_in",
    target: "multiple",
    pluralOf: "neq",
    relativeOf: "in",
    isNegated: true,
    negationOf: "in",
  },
} as const satisfies FilterDetails<"option">;

/* Details for all the filter operators for multi-option data type.
 *
 * Note: `in` maps to bazza's "include" / "include any of" semantics.
 * `includesAll` maps to "include all of". `excludesAny` maps to "exclude if any of".
 * `not_in` maps to "exclude" / "exclude if all".
 */
export const multiOptionFilterOperators = {
  in: {
    key: "operators.in",
    value: "in",
    target: "multiple",
    pluralOf: "in",
    relativeOf: ["not_in", "includesAll", "excludesAny"],
    isNegated: false,
    negation: "not_in",
  },
  not_in: {
    key: "operators.not_in",
    value: "not_in",
    target: "multiple",
    pluralOf: "not_in",
    relativeOf: ["in", "includesAll", "excludesAny"],
    isNegated: true,
    negationOf: "in",
  },
  includesAll: {
    key: "operators.includesAll",
    value: "includesAll",
    target: "multiple",
    pluralOf: "includesAll",
    relativeOf: ["in", "not_in", "excludesAny"],
    isNegated: false,
    negation: "excludesAny",
  },
  excludesAny: {
    key: "operators.excludesAny",
    value: "excludesAny",
    target: "multiple",
    pluralOf: "excludesAny",
    relativeOf: ["in", "not_in", "includesAll"],
    isNegated: true,
    negationOf: "includesAll",
  },
} as const satisfies FilterDetails<"multiOption">;

/* Details for all the filter operators for date data type */
export const dateFilterOperators = {
  eq: {
    key: "operators.eq",
    value: "eq",
    target: "single",
    singularOf: "between",
    relativeOf: "gt",
    isNegated: false,
    negation: "lt",
  },
  neq: {
    key: "operators.neq",
    value: "neq",
    target: "single",
    singularOf: "notBetween",
    relativeOf: ["eq", "lt", "gte", "gt", "lte"],
    isNegated: true,
    negationOf: "eq",
  },
  lt: {
    key: "operators.date.lt",
    value: "lt",
    target: "single",
    singularOf: "between",
    relativeOf: ["eq", "neq", "gte", "gt", "lte"],
    isNegated: false,
    negation: "gte",
  },
  gte: {
    key: "operators.date.gte",
    value: "gte",
    target: "single",
    singularOf: "between",
    relativeOf: ["eq", "neq", "lt", "gt", "lte"],
    isNegated: false,
    negation: "lt",
  },
  gt: {
    key: "operators.date.gt",
    value: "gt",
    target: "single",
    singularOf: "between",
    relativeOf: ["eq", "neq", "lt", "gte", "lte"],
    isNegated: false,
    negation: "lte",
  },
  lte: {
    key: "operators.date.lte",
    value: "lte",
    target: "single",
    singularOf: "between",
    relativeOf: ["eq", "neq", "gt", "gte", "lt"],
    isNegated: false,
    negation: "gt",
  },
  between: {
    key: "operators.between",
    value: "between",
    target: "multiple",
    pluralOf: "eq",
    relativeOf: "notBetween",
    isNegated: false,
    negation: "notBetween",
  },
  notBetween: {
    key: "operators.notBetween",
    value: "notBetween",
    target: "multiple",
    pluralOf: "neq",
    relativeOf: "between",
    isNegated: true,
    negationOf: "between",
  },
} as const satisfies FilterDetails<"date">;

/* Details for all the filter operators for text data type */
export const textFilterOperators = {
  contains: {
    key: "operators.contains",
    value: "contains",
    target: "single",
    relativeOf: "notContains",
    isNegated: false,
    negation: "notContains",
  },
  notContains: {
    key: "operators.notContains",
    value: "notContains",
    target: "single",
    relativeOf: "contains",
    isNegated: true,
    negationOf: "contains",
  },
} as const satisfies FilterDetails<"text">;

/* Details for all the filter operators for number data type */
export const numberFilterOperators = {
  eq: {
    key: "operators.eq",
    value: "eq",
    target: "single",
    singularOf: "between",
    relativeOf: ["neq", "gt", "lte", "lt", "gte"],
    isNegated: false,
    negation: "neq",
  },
  neq: {
    key: "operators.neq",
    value: "neq",
    target: "single",
    singularOf: "notBetween",
    relativeOf: ["eq", "gt", "lte", "lt", "gte"],
    isNegated: true,
    negationOf: "eq",
  },
  gt: {
    key: "operators.gt",
    value: "gt",
    target: "single",
    singularOf: "between",
    relativeOf: ["eq", "neq", "lte", "lt", "gte"],
    isNegated: false,
    negation: "lte",
  },
  gte: {
    key: "operators.gte",
    value: "gte",
    target: "single",
    singularOf: "between",
    relativeOf: ["eq", "neq", "gt", "lte", "lt"],
    isNegated: false,
    negation: "lte",
  },
  lt: {
    key: "operators.lt",
    value: "lt",
    target: "single",
    singularOf: "between",
    relativeOf: ["eq", "neq", "gt", "lte", "gte"],
    isNegated: false,
    negation: "gt",
  },
  lte: {
    key: "operators.lte",
    value: "lte",
    target: "single",
    singularOf: "between",
    relativeOf: ["eq", "neq", "gt", "lt", "gte"],
    isNegated: false,
    negation: "gte",
  },
  between: {
    key: "operators.between",
    value: "between",
    target: "multiple",
    pluralOf: "eq",
    relativeOf: "notBetween",
    isNegated: false,
    negation: "notBetween",
  },
  notBetween: {
    key: "operators.notBetween",
    value: "notBetween",
    target: "multiple",
    pluralOf: "neq",
    relativeOf: "between",
    isNegated: true,
    negationOf: "between",
  },
} as const satisfies FilterDetails<"number">;

export const filterTypeOperatorDetails: FilterTypeOperatorDetails = {
  text: textFilterOperators,
  number: numberFilterOperators,
  date: dateFilterOperators,
  option: optionFilterOperators,
  multiOption: multiOptionFilterOperators,
};

/*
 *
 * Determines the new operator for a filter based on the current operator, old and new filter values.
 *
 * This handles cases where the filter values have transitioned from a single value to multiple values (or vice versa),
 * and the current operator needs to be transitioned to its plural form (or singular form).
 *
 * For example, if the current operator is 'eq', and the new filter values have a length of 2, the
 * new operator would be 'in'.
 *
 */
export function determineNewOperator<TType extends ColumnDataType>(
  type: TType,
  oldVals: FilterValues<TType>,
  nextVals: FilterValues<TType>,
  currentOperator: FilterOperators[TType],
): FilterOperators[TType] {
  const a =
    Array.isArray(oldVals) && Array.isArray(oldVals[0]) ? oldVals[0].length : oldVals.length;
  const b =
    Array.isArray(nextVals) && Array.isArray(nextVals[0]) ? nextVals[0].length : nextVals.length;

  // If filter size has not transitioned from single to multiple (or vice versa)
  // or is unchanged, return the current operator.
  if (a === b || (a >= 2 && b >= 2) || (a <= 1 && b <= 1)) return currentOperator;

  const opDetails = filterTypeOperatorDetails[type][currentOperator];

  // Handle transition from single to multiple filter values.
  if (a < b && b >= 2) return opDetails.singularOf ?? currentOperator;
  // Handle transition from multiple to single filter values.
  if (a > b && b <= 1) return opDetails.pluralOf ?? currentOperator;
  return currentOperator;
}
