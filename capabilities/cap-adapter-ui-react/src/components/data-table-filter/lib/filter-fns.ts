import { endOfDay, isAfter, isBefore, isSameDay, isWithinInterval, startOfDay } from "date-fns";
import { dateFilterOperators } from "../core/operators";
import type { FilterModel } from "../core/types";
import { intersection } from "./array";

export function optionFilterFn<_TData>(inputData: string, filterValue: FilterModel<"option">) {
  if (!inputData) return false;
  if (filterValue.values.length === 0) return true;

  const value = inputData.toString().toLowerCase();

  const found = !!filterValue.values.find((v) => v.toLowerCase() === value);

  switch (filterValue.operator) {
    case "eq":
    case "in":
      return found;
    case "neq":
    case "not_in":
      return !found;
  }
}

export function multiOptionFilterFn(inputData: string[], filterValue: FilterModel<"multiOption">) {
  if (!inputData) return false;

  if (
    filterValue.values.length === 0 ||
    !filterValue.values[0] ||
    filterValue.values[0].length === 0
  )
    return true;

  const values = inputData;
  const filterValues = filterValue.values;

  switch (filterValue.operator) {
    case "in":
      return intersection(values, filterValues).length > 0;
    case "not_in":
      return intersection(values, filterValues).length === 0;
    case "includesAll":
      return intersection(values, filterValues).length === filterValues.length;
    case "excludesAny":
      return !(intersection(values, filterValues).length === filterValues.length);
  }
}

export function dateFilterFn<_TData>(inputData: Date, filterValue: FilterModel<"date">) {
  if (!filterValue || filterValue.values.length === 0) return true;

  if (
    dateFilterOperators[filterValue.operator].target === "single" &&
    filterValue.values.length > 1
  )
    throw new Error("Singular operators require at most one filter value");

  if (
    (filterValue.operator === "between" || filterValue.operator === "notBetween") &&
    filterValue.values.length !== 2
  )
    throw new Error("Range operators require two filter values");

  const filterVals = filterValue.values;
  const d1 = filterVals[0];
  const d2 = filterVals[1];

  if (!d1) return true;

  const value = inputData;

  switch (filterValue.operator) {
    case "eq":
      return isSameDay(value, d1);
    case "neq":
      return !isSameDay(value, d1);
    case "lt":
      return isBefore(value, startOfDay(d1));
    case "gte":
      return isSameDay(value, d1) || isAfter(value, startOfDay(d1));
    case "gt":
      return isAfter(value, startOfDay(d1));
    case "lte":
      return isSameDay(value, d1) || isBefore(value, startOfDay(d1));
    case "between":
      return d2
        ? isWithinInterval(value, {
            start: startOfDay(d1),
            end: endOfDay(d2),
          })
        : true;
    case "notBetween":
      return d2
        ? !isWithinInterval(value, {
            start: startOfDay(d1),
            end: endOfDay(d2),
          })
        : true;
  }
}

export function textFilterFn<_TData>(inputData: string, filterValue: FilterModel<"text">) {
  if (!filterValue || filterValue.values.length === 0) return true;

  const value = inputData.toLowerCase().trim();
  const firstValue = filterValue.values[0];
  if (!firstValue) return true;
  const filterStr = firstValue.toLowerCase().trim();

  if (filterStr === "") return true;

  const found = value.includes(filterStr);

  switch (filterValue.operator) {
    case "contains":
      return found;
    case "notContains":
      return !found;
  }
}

export function numberFilterFn<_TData>(inputData: number, filterValue: FilterModel<"number">) {
  if (!filterValue || !filterValue.values || filterValue.values.length === 0) {
    return true;
  }

  const value = inputData;
  const filterVal = filterValue.values[0] ?? 0;

  switch (filterValue.operator) {
    case "eq":
      return value === filterVal;
    case "neq":
      return value !== filterVal;
    case "gt":
      return value > filterVal;
    case "gte":
      return value >= filterVal;
    case "lt":
      return value < filterVal;
    case "lte":
      return value <= filterVal;
    case "between": {
      const lowerBound = filterValue.values[0] ?? 0;
      const upperBound = filterValue.values[1] ?? 0;
      return value >= lowerBound && value <= upperBound;
    }
    case "notBetween": {
      const lowerBound = filterValue.values[0] ?? 0;
      const upperBound = filterValue.values[1] ?? 0;
      return value < lowerBound || value > upperBound;
    }
    default:
      return true;
  }
}
