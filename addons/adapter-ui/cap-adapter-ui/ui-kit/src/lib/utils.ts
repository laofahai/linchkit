import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export { formatRelativeTime, type RelativeTimeTranslator } from "./format-relative-time";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
