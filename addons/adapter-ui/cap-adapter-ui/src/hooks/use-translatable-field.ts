/**
 * Hook for managing translatable field state.
 *
 * Provides locale switching, per-locale value access, and update helpers
 * for fields with `translatable: true`.
 */

import { useCallback, useMemo, useState } from "react";

export interface UseTranslatableFieldReturn {
  /** Current active locale for editing */
  currentLocale: string;
  /** Set active locale */
  setCurrentLocale: (locale: string) => void;
  /** Value for current locale */
  currentValue: string;
  /** All locale values as Record<string, string> */
  allValues: Record<string, string>;
  /** Available locales (from value + schema config) */
  availableLocales: string[];
  /** Update value for a specific locale */
  setLocaleValue: (locale: string, value: string) => Record<string, string>;
  /** Whether current locale is the default locale */
  isDefaultLocale: boolean;
  /** Default locale from schema config */
  defaultLocale: string;
}

/**
 * Manage translatable field editing state.
 *
 * @param value - Current field value (string or Record<string, string>)
 * @param options - Default locale and supported locales from schema i18n config
 */
export function useTranslatableField(
  value: unknown,
  options?: { defaultLocale?: string; supportedLocales?: string[] },
): UseTranslatableFieldReturn {
  const defaultLocale = options?.defaultLocale ?? "en";
  const [currentLocale, setCurrentLocale] = useState(defaultLocale);

  // Normalize value into a locale map
  const allValues = useMemo<Record<string, string>>(() => {
    if (value === null || value === undefined) return {};
    if (typeof value === "string") return { [defaultLocale]: value };
    if (typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, string>;
    }
    return {};
  }, [value, defaultLocale]);

  // Merge locales from value keys + supported locales config
  const availableLocales = useMemo(() => {
    const set = new Set<string>();
    // Always include default locale first
    set.add(defaultLocale);
    // Add locales from existing values
    for (const k of Object.keys(allValues)) {
      set.add(k);
    }
    // Add configured supported locales
    if (options?.supportedLocales) {
      for (const l of options.supportedLocales) {
        set.add(l);
      }
    }
    return Array.from(set);
  }, [allValues, defaultLocale, options?.supportedLocales]);

  const currentValue = allValues[currentLocale] ?? "";
  const isDefaultLocale = currentLocale === defaultLocale;

  const setLocaleValue = useCallback(
    (locale: string, newValue: string): Record<string, string> => {
      return { ...allValues, [locale]: newValue };
    },
    [allValues],
  );

  return {
    currentLocale,
    setCurrentLocale,
    currentValue,
    allValues,
    availableLocales,
    setLocaleValue,
    isDefaultLocale,
    defaultLocale,
  };
}
