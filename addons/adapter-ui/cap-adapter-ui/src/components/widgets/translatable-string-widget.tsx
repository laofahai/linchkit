/**
 * Translatable string widget — locale tabs + text input.
 *
 * Display mode: shows resolved value with a small locale badge.
 * Input mode: locale pill tabs at top + standard Input below.
 *
 * The widget infers locale info from:
 * - Value object keys (existing translations)
 * - viewField.options.defaultLocale / viewField.options.supportedLocales (set by form)
 * - i18next.language as fallback current locale
 */

import { Badge, Input } from "@linchkit/ui-kit/components";
import { cn } from "@linchkit/ui-kit/lib/utils";
import i18next from "i18next";
import { Globe } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTranslatableField } from "@/hooks/use-translatable-field";
import type { WidgetDisplayProps, WidgetInputProps } from "@/lib/widget-registry";
import { requiredBg } from "./utils";

/** Extract i18n options from viewField.options or sensible defaults */
function extractI18nOptions(viewField: { options?: Record<string, unknown> }) {
  const opts = viewField.options ?? {};
  return {
    defaultLocale: (opts.defaultLocale as string) ?? i18next.language ?? "en",
    supportedLocales: (opts.supportedLocales as string[]) ?? undefined,
  };
}

/** Display: show resolved value with locale indicator */
export function TranslatableStringDisplay({ value, fieldDef, viewField }: WidgetDisplayProps) {
  const i18nOpts = extractI18nOptions(viewField);
  const { currentValue, availableLocales } = useTranslatableField(value, i18nOpts);

  if (!currentValue) {
    return <span className="text-muted-foreground leading-9">&mdash;</span>;
  }

  return (
    <span className="inline-flex items-center gap-1.5 max-w-full min-w-0 leading-9">
      <span className="truncate">{currentValue}</span>
      {availableLocales.length > 1 && (
        <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 shrink-0">
          <Globe className="size-2.5 mr-0.5" />
          {availableLocales.length}
        </Badge>
      )}
    </span>
  );
}

/** Input: locale pill tabs + text input */
export function TranslatableStringInput({
  value,
  fieldDef,
  viewField,
  onChange,
  onBlur,
  readonly,
  error,
  dirty,
  required,
}: WidgetInputProps) {
  const { t } = useTranslation();
  const i18nOpts = extractI18nOptions(viewField);

  const {
    currentLocale,
    setCurrentLocale,
    currentValue,
    allValues,
    availableLocales,
    setLocaleValue,
    isDefaultLocale,
    defaultLocale,
  } = useTranslatableField(value, i18nOpts);

  const handleChange = (newText: string) => {
    const updated = setLocaleValue(currentLocale, newText);
    onChange(updated);
  };

  return (
    <div className="space-y-1">
      {/* Locale tabs */}
      <div className="flex items-center gap-1 flex-wrap">
        {availableLocales.map((locale) => {
          const isActive = locale === currentLocale;
          const isDefault = locale === defaultLocale;
          const hasValue = !!allValues[locale];
          return (
            <button
              key={locale}
              type="button"
              onClick={() => setCurrentLocale(locale)}
              className={cn(
                "inline-flex items-center gap-0.5 px-2 py-0.5 text-xs rounded-md border transition-colors",
                isActive
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-background hover:bg-muted border-input",
                !hasValue && !isActive && "opacity-50",
              )}
            >
              {locale}
              {isDefault && <span className="text-[10px]">●</span>}
            </button>
          );
        })}
      </div>

      {/* Text input */}
      <Input
        type="text"
        value={currentValue}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={onBlur}
        disabled={readonly}
        placeholder={
          isDefaultLocale
            ? t("translatable.enterDefault", "Enter default value")
            : t("translatable.enterTranslation", "Enter translation for {{locale}}", {
                locale: currentLocale,
              })
        }
        aria-invalid={!!error}
        className={cn(
          required && requiredBg,
          dirty && !error && "border-ring",
          error && "border-destructive focus-visible:ring-destructive",
        )}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
