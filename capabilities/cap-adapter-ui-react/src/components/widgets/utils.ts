/**
 * Shared helpers for widget implementations.
 */

/** Subtle background for required fields (no asterisk) */
export const requiredBg = "bg-muted";

export function formatDate(value: unknown): string {
  try {
    const d = value instanceof Date ? value : new Date(String(value));
    return d.toLocaleDateString();
  } catch {
    return String(value);
  }
}

export function formatDateTime(value: unknown): string {
  try {
    const d = value instanceof Date ? value : new Date(String(value));
    return d.toLocaleString();
  } catch {
    return String(value);
  }
}

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

export function toDateInputValue(value: unknown): string {
  try {
    const d = value instanceof Date ? value : new Date(String(value));
    return d.toISOString().split("T")[0] ?? "";
  } catch {
    return String(value);
  }
}

export function toDateTimeInputValue(value: unknown): string {
  try {
    const d = value instanceof Date ? value : new Date(String(value));
    return d.toISOString().slice(0, 16);
  } catch {
    return String(value);
  }
}
