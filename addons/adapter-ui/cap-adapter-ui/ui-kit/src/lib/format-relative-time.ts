/**
 * Shared relative-time formatting.
 *
 * Single source of truth for the "Xm ago / Xh ago / Xd ago" timestamps
 * rendered across cap-adapter-ui, cap-chatter-ui and cap-mcp-ui.
 *
 * i18n: callers that render localized UI pass their i18next `t` function;
 * the translation keys (`time.justNow`, `time.minutesAgo`, `time.hoursAgo`,
 * `time.daysAgo`) and `{{count}}` interpolation are preserved exactly so
 * existing locale bundles keep working. Callers without i18n omit `t` and
 * get the English default values.
 */

/** Translator signature compatible with i18next's `t` function. */
export type RelativeTimeTranslator = (key: string, options?: Record<string, unknown>) => string;

/** Fallback translator: renders the English default value with `{{count}}` interpolation. */
const defaultTranslator: RelativeTimeTranslator = (_key, options) => {
  const template = String(options?.defaultValue ?? "");
  const count = options?.count;
  return count === undefined ? template : template.replace("{{count}}", String(count));
};

/**
 * Format an ISO timestamp as a relative time string (e.g. "5m ago").
 *
 * Timestamps older than 30 days fall back to the locale date string.
 * Falsy or unparseable input renders as "" rather than a misleading
 * epoch date or "Invalid Date".
 */
export function formatRelativeTime(
  iso: string | null | undefined,
  t: RelativeTimeTranslator = defaultTranslator,
): string {
  if (!iso) return "";
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) return "";
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return t("time.justNow", { defaultValue: "just now" });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("time.minutesAgo", { defaultValue: "{{count}}m ago", count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("time.hoursAgo", { defaultValue: "{{count}}h ago", count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t("time.daysAgo", { defaultValue: "{{count}}d ago", count: days });
  return new Date(iso).toLocaleDateString();
}
