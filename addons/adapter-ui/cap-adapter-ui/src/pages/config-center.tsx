/**
 * ConfigCenterPage — Unified configuration management page.
 *
 * Layout (full-width):
 *   - Left sidebar: capability/namespace grouping navigation
 *   - Right content: structured config items with inline editing
 *
 * Config items come from capability `defineConfigSchema()` declarations.
 * Editing persists through the ConfigStore API (with versioning).
 * No freeform KV entry creation — only declared config items are editable.
 */

import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  Input,
  Label,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "@linchkit/ui-kit/components";
import {
  CheckCircleIcon,
  ClockIcon,
  HistoryIcon,
  RefreshCwIcon,
  SaveIcon,
  SettingsIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ConfigHistoryEntry, ConfigItem } from "../lib/config-api";
import {
  fetchConfig,
  fetchConfigHistory,
  fetchConfigs,
  updateConfigValues,
} from "../lib/config-api";

// ── Field Editor (reused for inline editing) ──────────────

interface FieldEditorProps {
  name: string;
  field: ConfigItem["fields"][string];
  value: unknown;
  onChange: (value: unknown) => void;
}

function FieldEditor({ name, field, value, onChange }: FieldEditorProps) {
  const { t } = useTranslation();

  if (field.type === "boolean") {
    return (
      <div className="flex items-center gap-2">
        <Switch id={name} checked={Boolean(value)} onCheckedChange={onChange} />
        <Label htmlFor={name} className="text-sm">
          {field.label ?? name}
        </Label>
      </div>
    );
  }

  if (field.type === "json") {
    return (
      <div className="space-y-1">
        <Label htmlFor={name} className="text-sm">
          {field.label ?? name}
        </Label>
        <Textarea
          id={name}
          value={typeof value === "string" ? value : JSON.stringify(value, null, 2)}
          onChange={(e) => {
            try {
              onChange(JSON.parse(e.target.value));
            } catch {
              onChange(e.target.value);
            }
          }}
          rows={4}
          className="font-mono text-sm"
          placeholder={t("config.jsonPlaceholder", "Enter JSON value")}
        />
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <Label htmlFor={name} className="text-sm">
        {field.label ?? name}
      </Label>
      <Input
        id={name}
        type={field.secret ? "password" : field.type === "number" ? "number" : "text"}
        value={value === undefined || value === null ? "" : String(value)}
        onChange={(e) => {
          if (field.type === "number") {
            const n = Number(e.target.value);
            onChange(Number.isNaN(n) ? e.target.value : n);
          } else {
            onChange(e.target.value);
          }
        }}
        placeholder={field.description ?? ""}
      />
    </div>
  );
}

// ── Config Namespace Editor ───────────────────────────────

function ConfigNamespaceEditor({ config, onSaved }: { config: ConfigItem; onSaved: () => void }) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, unknown>>({
    ...config.values,
  });
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [historyField, setHistoryField] = useState<string | null>(null);
  const [history, setHistory] = useState<ConfigHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Reset values when config changes (namespace switch)
  useEffect(() => {
    setValues({ ...config.values });
    setSavedAt(null);
    setError(null);
    setHistoryField(null);
  }, [config.values]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await updateConfigValues(config.name, values);
      setSavedAt(new Date().toLocaleTimeString());
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [config.name, values, onSaved]);

  const loadHistory = useCallback(
    async (field?: string) => {
      setHistoryLoading(true);
      try {
        const entries = await fetchConfigHistory(config.name, field);
        setHistory(entries);
      } finally {
        setHistoryLoading(false);
      }
    },
    [config.name],
  );

  const toggleHistory = useCallback(() => {
    if (historyField !== null) {
      setHistoryField(null);
      return;
    }
    setHistoryField("__all__");
    loadHistory();
  }, [historyField, loadHistory]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold">{config.label ?? config.name}</h2>
        <p className="text-sm text-muted-foreground">
          <code className="text-xs">{config.name}</code>
          {config.schema !== config.name && (
            <span className="ml-2">
              {t("config.ownedBy", "owned by")} <code className="text-xs">{config.schema}</code>
            </span>
          )}
        </p>
      </div>

      {/* Fields */}
      <div className="space-y-4">
        {Object.entries(config.fields).map(([fieldName, field]) => (
          <div key={fieldName} className="space-y-1">
            <FieldEditor
              name={fieldName}
              field={field}
              value={values[fieldName]}
              onChange={(v) => setValues((prev) => ({ ...prev, [fieldName]: v }))}
            />
            {field.description && (
              <p className="text-xs text-muted-foreground pl-0.5">{field.description}</p>
            )}
            {field.default !== undefined && (
              <p className="text-xs text-muted-foreground pl-0.5">
                {t("config.defaultValue", "Default")}: {String(field.default)}
              </p>
            )}
          </div>
        ))}
      </div>

      {/* Error */}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Save + History buttons */}
      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={saving}>
          <SaveIcon className="size-4 mr-1" />
          {saving ? t("common.saving", "Saving...") : t("common.save", "Save")}
        </Button>
        <Button variant="outline" onClick={toggleHistory}>
          <HistoryIcon className="size-4 mr-1" />
          {t("config.history", "History")}
        </Button>
        {savedAt && (
          <span className="text-sm text-muted-foreground flex items-center gap-1">
            <CheckCircleIcon className="size-3 text-green-500" />
            {t("config.savedAt", "Saved at {{time}}", { time: savedAt })}
          </span>
        )}
      </div>

      {/* History panel */}
      {historyField !== null && (
        <div className="border rounded-md p-4 bg-muted/30">
          <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <ClockIcon className="size-4" />
            {t("config.versionHistory", "Version history")}
          </h4>
          {historyLoading ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              {t("common.loading", "Loading...")}
            </p>
          ) : history.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              {t("config.noHistory", "No changes recorded yet.")}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">{t("config.field", "Field")}</TableHead>
                  <TableHead className="text-xs">{t("config.oldValue", "Old Value")}</TableHead>
                  <TableHead className="text-xs">{t("config.newValue", "New Value")}</TableHead>
                  <TableHead className="text-xs">{t("config.changedAt", "Changed At")}</TableHead>
                  <TableHead className="text-xs">{t("config.changedBy", "Changed By")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((entry, idx) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: history entries have no stable id
                  <TableRow key={idx}>
                    <TableCell className="font-mono text-xs">{entry.fieldName}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {entry.oldValue === undefined ? (
                        <em>{t("config.noValue", "(none)")}</em>
                      ) : (
                        String(entry.oldValue)
                      )}
                    </TableCell>
                    <TableCell className="text-xs font-medium">{String(entry.newValue)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(entry.changedAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {entry.changedBy ?? "-"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────

export function ConfigCenterPage() {
  const { t } = useTranslation();
  const [configs, setConfigs] = useState<ConfigItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeNamespace, setActiveNamespace] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const items = await fetchConfigs();
      setConfigs(items);
      // Select first namespace if none is selected
      if (items.length > 0 && !activeNamespace) {
        const first = items[0];
        if (first) setActiveNamespace(first.name);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [activeNamespace]);

  useEffect(() => {
    load();
  }, [load]);

  const refreshConfig = useCallback(async (name: string) => {
    const updated = await fetchConfig(name);
    if (updated) {
      setConfigs((prev) => prev.map((c) => (c.name === name ? updated : c)));
    }
  }, []);

  const activeConfig = configs.find((c) => c.name === activeNamespace);

  // Group configs by schema (capability owner)
  const groupedBySchema = configs.reduce<Record<string, ConfigItem[]>>((acc, c) => {
    const key = c.schema ?? c.name;
    if (!acc[key]) acc[key] = [];
    acc[key].push(c);
    return acc;
  }, {});

  return (
    <div className="w-full p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t("config.title", "Config Center")}</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {t(
              "config.unifiedSubtitle",
              "Structured configuration items declared by capabilities.",
            )}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCwIcon className={`size-4 mr-1 ${loading ? "animate-spin" : ""}`} />
          {t("common.refresh", "Refresh")}
        </Button>
      </div>

      {/* Error */}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Loading */}
      {loading && configs.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          {t("common.loading", "Loading...")}
        </p>
      )}

      {/* Empty state */}
      {!loading && configs.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <SettingsIcon className="size-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground">
              {t("config.empty", "No config namespaces registered yet.")}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {t(
                "config.emptyHintDefine",
                "Register config items via defineConfigSchema() in your capabilities.",
              )}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Main content: sidebar + editor */}
      {configs.length > 0 && (
        <div className="flex gap-6">
          {/* Left sidebar: namespace navigation */}
          <div className="w-56 shrink-0 space-y-1">
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              {t("config.namespaces", "Namespaces")}
            </div>
            {Object.entries(groupedBySchema).map(([schema, items]) => (
              <div key={schema}>
                {Object.keys(groupedBySchema).length > 1 && (
                  <div className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider mt-3 mb-1 px-2.5">
                    {schema}
                  </div>
                )}
                {items.map((c) => (
                  <button
                    key={c.name}
                    type="button"
                    className={`w-full text-left text-sm px-2.5 py-1.5 rounded-md transition-colors ${
                      activeNamespace === c.name
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-muted text-muted-foreground"
                    }`}
                    onClick={() => setActiveNamespace(c.name)}
                  >
                    <span className="block truncate">{c.label ?? c.name}</span>
                    <span className="block text-[10px] opacity-70">
                      {Object.keys(c.fields).length} {t("config.fields", "fields")}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>

          {/* Right content: config editor */}
          <div className="flex-1 min-w-0">
            {activeConfig ? (
              <ConfigNamespaceEditor
                config={activeConfig}
                onSaved={() => refreshConfig(activeConfig.name)}
              />
            ) : (
              <div className="text-sm text-muted-foreground text-center py-12">
                {t("config.selectNamespace", "Select a configuration namespace to edit.")}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
