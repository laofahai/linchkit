/**
 * Hook for resolving schema/field labels with i18n support.
 *
 * Convention: if a label starts with "t:", it is treated as an i18n key
 * and looked up via i18next. Otherwise, the literal string is used.
 *
 * Examples:
 *   label: "采购申请"           -> "采购申请" (literal)
 *   label: "t:schema.purchase"  -> i18next.t("schema.purchase")
 *   label: undefined            -> fallback value
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";

const I18N_PREFIX = "t:";

/**
 * Hook that returns a resolver function for schema/field labels.
 * The resolver checks if the label uses the `t:` prefix convention
 * and looks up the translation. Otherwise returns the literal string.
 */
export function useSchemaLabel() {
  const { t } = useTranslation();

  const resolveLabel = useCallback(
    (label: string | undefined, fallback: string): string => {
      if (!label) return fallback;
      if (label.startsWith(I18N_PREFIX)) {
        const key = label.slice(I18N_PREFIX.length);
        return t(key, { defaultValue: fallback });
      }
      return label;
    },
    [t],
  );

  return { resolveLabel };
}

/**
 * Non-hook utility for resolving schema labels outside React components.
 * Uses the i18n instance directly.
 */
export function resolveEntityLabel(
  i18n: { t: (key: string, options?: Record<string, unknown>) => string },
  label: string | undefined,
  fallback: string,
): string {
  if (!label) return fallback;
  if (label.startsWith(I18N_PREFIX)) {
    const key = label.slice(I18N_PREFIX.length);
    return i18n.t(key, { defaultValue: fallback });
  }
  return label;
}
