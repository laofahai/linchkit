/**
 * ConfigCenterPage — Admin page for runtime config management.
 *
 * Shows all registered config namespaces with their current values.
 * Allows editing field values and viewing version history.
 */

import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from "@linchkit/ui-kit/components";
import { CheckCircleIcon, ClockIcon, RefreshCwIcon, SaveIcon, SettingsIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ConfigHistoryEntry,
  ConfigItem,
} from "../lib/api";
import {
  fetchConfig,
  fetchConfigHistory,
  fetchConfigs,
  updateConfigValues,
} from "../lib/api";

// ── Config field editor ──────────────────────────────────

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
        <Switch
          id={name}
          checked={Boolean(value)}
          onCheckedChange={onChange}
        />
        <Label htmlFor={name}>{field.label ?? name}</Label>
      </div>
    );
  }

  if (field.type === "json") {
    return (
      <div className="space-y-1">
        <Label htmlFor={name}>{field.label ?? name}</Label>
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
      <Label htmlFor={name}>{field.label ?? name}</Label>
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

// ── Config namespace editor ──────────────────────────────

interface ConfigEditorProps {
  config: ConfigItem;
  onSaved: () => void;
}

function ConfigEditor({ config, onSaved }: ConfigEditorProps) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, unknown>>({ ...config.values });
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="space-y-4">
      {Object.entries(config.fields).map(([fieldName, field]) => (
        <FieldEditor
          key={fieldName}
          name={fieldName}
          field={field}
          value={values[fieldName]}
          onChange={(v) => setValues((prev) => ({ ...prev, [fieldName]: v }))}
        />
      ))}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={saving}>
          <SaveIcon className="size-4 mr-1" />
          {saving ? t("common.saving", "Saving...") : t("common.save", "Save")}
        </Button>
        {savedAt && (
          <span className="text-sm text-muted-foreground flex items-center gap-1">
            <CheckCircleIcon className="size-3 text-green-500" />
            {t("config.savedAt", "Saved at {{time}}", { time: savedAt })}
          </span>
        )}
      </div>
    </div>
  );
}

// ── History table ────────────────────────────────────────

interface HistoryTableProps {
  entries: ConfigHistoryEntry[];
}

function HistoryTable({ entries }: HistoryTableProps) {
  const { t } = useTranslation();

  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4 text-center">
        {t("config.noHistory", "No changes recorded yet.")}
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("config.field", "Field")}</TableHead>
          <TableHead>{t("config.oldValue", "Old Value")}</TableHead>
          <TableHead>{t("config.newValue", "New Value")}</TableHead>
          <TableHead>{t("config.changedAt", "Changed At")}</TableHead>
          <TableHead>{t("config.changedBy", "Changed By")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((entry, idx) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: history entries have no stable id
          <TableRow key={idx}>
            <TableCell className="font-mono text-sm">{entry.fieldName}</TableCell>
            <TableCell className="text-muted-foreground text-sm">
              {entry.oldValue === undefined
                ? <em>{t("config.noValue", "(none)")}</em>
                : String(entry.oldValue)}
            </TableCell>
            <TableCell className="text-sm font-medium">
              {String(entry.newValue)}
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {new Date(entry.changedAt).toLocaleString()}
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {entry.changedBy ?? "-"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ── Config namespace card ────────────────────────────────

interface ConfigNamespaceCardProps {
  config: ConfigItem;
  onSaved: () => void;
}

function ConfigNamespaceCard({ config, onSaved }: ConfigNamespaceCardProps) {
  const { t } = useTranslation();
  const [history, setHistory] = useState<ConfigHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("values");

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const entries = await fetchConfigHistory(config.name);
      setHistory(entries);
    } finally {
      setHistoryLoading(false);
    }
  }, [config.name]);

  const handleTabChange = useCallback(
    (tab: string) => {
      setActiveTab(tab);
      if (tab === "history" && history.length === 0) {
        loadHistory();
      }
    },
    [history.length, loadHistory],
  );

  const handleSaved = useCallback(() => {
    onSaved();
    // Refresh history after save
    loadHistory();
  }, [onSaved, loadHistory]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base font-semibold">
              {config.label ?? config.name}
            </CardTitle>
            <CardDescription>
              <code className="text-xs">{config.name}</code>
              {config.schema !== config.name && (
                <span className="ml-2 text-muted-foreground">
                  {t("config.ownedBy", "owned by")} <code className="text-xs">{config.schema}</code>
                </span>
              )}
            </CardDescription>
          </div>
          <Badge variant="outline">
            {Object.keys(config.fields).length} {t("config.fields", "fields")}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <Tabs value={activeTab} onValueChange={handleTabChange}>
          <TabsList className="mb-4">
            <TabsTrigger value="values">
              <SettingsIcon className="size-3 mr-1" />
              {t("config.values", "Values")}
            </TabsTrigger>
            <TabsTrigger value="history">
              <ClockIcon className="size-3 mr-1" />
              {t("config.history", "History")}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="values">
            <ConfigEditor config={config} onSaved={handleSaved} />
          </TabsContent>
          <TabsContent value="history">
            {historyLoading ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                {t("common.loading", "Loading...")}
              </p>
            ) : (
              <HistoryTable entries={history} />
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

// ── Main page ────────────────────────────────────────────

export function ConfigCenterPage() {
  const { t } = useTranslation();
  const [configs, setConfigs] = useState<ConfigItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const items = await fetchConfigs();
      setConfigs(items);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const refreshConfig = useCallback(
    async (name: string) => {
      const updated = await fetchConfig(name);
      if (updated) {
        setConfigs((prev) => prev.map((c) => (c.name === name ? updated : c)));
      }
    },
    [],
  );

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t("config.title", "Config Center")}</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {t("config.subtitle", "Manage runtime configuration for registered namespaces.")}
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
      {loading && !error && (
        <p className="text-sm text-muted-foreground text-center py-8">
          {t("common.loading", "Loading...")}
        </p>
      )}

      {/* Empty state */}
      {!loading && !error && configs.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <SettingsIcon className="size-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground">
              {t("config.empty", "No config namespaces registered yet.")}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Config cards */}
      {!loading &&
        configs.map((config) => (
          <ConfigNamespaceCard
            key={config.name}
            config={config}
            onSaved={() => refreshConfig(config.name)}
          />
        ))}
    </div>
  );
}
