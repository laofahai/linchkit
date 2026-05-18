/**
 * TenantConfigEditor — edit tenant default locale plus a KV map of feature flags.
 *
 * Values support boolean / string / number. Booleans render as a Switch,
 * numbers as a numeric Input, anything else as a text Input. Users can
 * also remove keys or add new ones at the bottom.
 */

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from "@linchkit/ui-kit/components";
import { Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TenantConfig } from "./tenant-self-service-types";

export interface TenantConfigEditorProps {
  value: TenantConfig;
  /** BCP-47 tags the tenant can choose from. */
  availableLocales?: readonly string[];
  onSave: (next: TenantConfig) => Promise<void> | void;
  disabled?: boolean;
}

const DEFAULT_LOCALES = ["en", "zh-CN", "ja", "de", "fr"] as const;

type FeatureKind = "boolean" | "number" | "string";

interface DraftRow {
  key: string;
  kind: FeatureKind;
  value: boolean | number | string;
}

function inferKind(value: unknown): FeatureKind {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  return "string";
}

function toRows(features: TenantConfig["features"]): DraftRow[] {
  return Object.entries(features).map(([key, value]) => ({
    key,
    kind: inferKind(value),
    value: value as boolean | number | string,
  }));
}

function fromRows(rows: DraftRow[]): TenantConfig["features"] {
  const out: TenantConfig["features"] = {};
  for (const row of rows) {
    const cleanKey = row.key.trim();
    if (!cleanKey) continue;
    out[cleanKey] = row.value;
  }
  return out;
}

export function TenantConfigEditor({
  value,
  availableLocales,
  onSave,
  disabled,
}: TenantConfigEditorProps) {
  const { t } = useTranslation();
  const locales = availableLocales ?? DEFAULT_LOCALES;
  const [locale, setLocale] = useState(value.defaultLocale);
  const [rows, setRows] = useState<DraftRow[]>(() => toRows(value.features));
  const [saving, setSaving] = useState(false);

  // Re-sync when parent supplies a fresh snapshot.
  useEffect(() => {
    setLocale(value.defaultLocale);
    setRows(toRows(value.features));
  }, [value]);

  const dirty = useMemo(() => {
    if (locale !== value.defaultLocale) return true;
    const nextFeatures = fromRows(rows);
    const nextKeys = Object.keys(nextFeatures).sort();
    const prevKeys = Object.keys(value.features).sort();
    if (nextKeys.length !== prevKeys.length) return true;
    if (nextKeys.some((k, i) => k !== prevKeys[i])) return true;
    return nextKeys.some((k) => nextFeatures[k] !== value.features[k]);
  }, [locale, rows, value]);

  const hasEmptyKey = rows.some((r) => !r.key.trim());
  const hasDuplicateKey = useMemo(() => {
    const seen = new Set<string>();
    for (const r of rows) {
      const k = r.key.trim();
      if (!k) continue;
      if (seen.has(k)) return true;
      seen.add(k);
    }
    return false;
  }, [rows]);

  const canSave = !disabled && !saving && dirty && !hasEmptyKey && !hasDuplicateKey;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await onSave({ defaultLocale: locale, features: fromRows(rows) });
    } finally {
      setSaving(false);
    }
  };

  const updateRow = (index: number, patch: Partial<DraftRow>) => {
    setRows((rs) => rs.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const changeKind = (index: number, kind: FeatureKind) => {
    setRows((rs) =>
      rs.map((r, i) => {
        if (i !== index) return r;
        let nextValue: DraftRow["value"];
        if (kind === "boolean") nextValue = Boolean(r.value);
        else if (kind === "number") nextValue = Number(r.value) || 0;
        else nextValue = String(r.value);
        return { ...r, kind, value: nextValue };
      }),
    );
  };

  const removeRow = (index: number) => {
    setRows((rs) => rs.filter((_, i) => i !== index));
  };

  const addRow = () => {
    setRows((rs) => [...rs, { key: "", kind: "boolean", value: false }]);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("tenant.config.title", "Configuration")}</CardTitle>
        <CardDescription>
          {t(
            "tenant.config.description",
            "Tune tenant-level feature toggles and the default locale used when a user has not chosen their own.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="tenant-default-locale">
            {t("tenant.config.defaultLocale", "Default locale")}
          </Label>
          <Select value={locale} onValueChange={setLocale} disabled={disabled}>
            <SelectTrigger id="tenant-default-locale" className="w-60">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {locales.map((loc) => (
                <SelectItem key={loc} value={loc}>
                  {loc}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label>{t("tenant.config.features", "Feature toggles")}</Label>
            <Button variant="outline" size="sm" onClick={addRow} disabled={disabled}>
              {t("tenant.config.addFeature", "Add feature")}
            </Button>
          </div>

          {rows.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {t("tenant.config.empty", "No feature toggles defined yet.")}
            </p>
          )}

          <div className="space-y-2">
            {rows.map((row, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: row identity is positional during editing
                key={index}
                className="grid grid-cols-[1fr_140px_1fr_auto] items-center gap-2 rounded-md border p-2"
              >
                <Input
                  value={row.key}
                  placeholder={t("tenant.config.keyPlaceholder", "feature_key")}
                  onChange={(e) => updateRow(index, { key: e.target.value })}
                  disabled={disabled}
                  className="font-mono text-sm"
                />
                <Select
                  value={row.kind}
                  onValueChange={(v) => changeKind(index, v as FeatureKind)}
                  disabled={disabled}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="boolean">boolean</SelectItem>
                    <SelectItem value="number">number</SelectItem>
                    <SelectItem value="string">string</SelectItem>
                  </SelectContent>
                </Select>

                {row.kind === "boolean" && (
                  <div className="flex items-center">
                    <Switch
                      checked={Boolean(row.value)}
                      onCheckedChange={(v) => updateRow(index, { value: Boolean(v) })}
                      disabled={disabled}
                    />
                  </div>
                )}
                {row.kind === "number" && (
                  <Input
                    type="number"
                    value={String(row.value)}
                    onChange={(e) => updateRow(index, { value: Number(e.target.value) })}
                    disabled={disabled}
                  />
                )}
                {row.kind === "string" && (
                  <Input
                    value={String(row.value)}
                    onChange={(e) => updateRow(index, { value: e.target.value })}
                    disabled={disabled}
                  />
                )}

                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeRow(index)}
                  disabled={disabled}
                  aria-label={t("tenant.config.removeFeature", "Remove feature")}
                >
                  <Trash2Icon className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>

          {hasDuplicateKey && (
            <p className="text-xs text-destructive">
              {t("tenant.config.duplicateKey", "Feature keys must be unique.")}
            </p>
          )}
          {hasEmptyKey && (
            <p className="text-xs text-destructive">
              {t("tenant.config.emptyKey", "Feature keys cannot be empty.")}
            </p>
          )}
        </div>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={!canSave}>
            {saving
              ? t("tenant.config.saving", "Saving...")
              : t("tenant.config.save", "Save configuration")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
