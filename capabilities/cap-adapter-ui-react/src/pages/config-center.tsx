/**
 * ConfigCenterPage — Admin page for unified configuration management.
 *
 * Three-layer config architecture:
 * 1. Static Config (ConfigRegistry) — read-only, requires restart to change
 * 2. Runtime Config (RuntimeConfigRegistry) — structured fields with validation
 * 3. Dynamic KV Config (ConfigStore) — freeform key-value with scope cascade and versioning
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@linchkit/ui-kit/components";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  ClockIcon,
  DatabaseIcon,
  HistoryIcon,
  LockIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SaveIcon,
  SettingsIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ConfigHistoryEntry,
  ConfigItem,
  ConfigStoreEntry,
  ConfigStoreScope,
  ConfigStoreScopeRef,
  ConfigStoreVersion,
} from "../lib/api";
import {
  deleteConfigStoreEntry,
  fetchConfig,
  fetchConfigHistory,
  fetchConfigStoreEntries,
  fetchConfigStoreHistory,
  fetchConfigs,
  rollbackConfigStoreEntry,
  setConfigStoreValue,
  updateConfigValues,
} from "../lib/api";

// ── Runtime Config Field Editor ─────────────────────────

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

// ── Runtime Config Editor ───────────────────────────────

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

// ── Runtime Config History Table ────────────────────────

function RuntimeHistoryTable({ entries }: { entries: ConfigHistoryEntry[] }) {
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
              {entry.oldValue === undefined ? (
                <em>{t("config.noValue", "(none)")}</em>
              ) : (
                String(entry.oldValue)
              )}
            </TableCell>
            <TableCell className="text-sm font-medium">{String(entry.newValue)}</TableCell>
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

// ── Runtime Config Namespace Card ───────────────────────

function RuntimeConfigCard({ config, onSaved }: { config: ConfigItem; onSaved: () => void }) {
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
    loadHistory();
  }, [onSaved, loadHistory]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base font-semibold">{config.label ?? config.name}</CardTitle>
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
              <RuntimeHistoryTable entries={history} />
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

// ── Static Config Card (read-only) ─────────────────────

interface StaticConfigData {
  general: Record<string, unknown>;
  database: Record<string, unknown>;
  ai: Record<string, unknown>;
  auth: Record<string, unknown>;
  tenancy: Record<string, unknown>;
  server: Record<string, unknown>;
  subscription: Record<string, unknown>;
  flow: Record<string, unknown>;
}

function StaticConfigSection({ label, data }: { label: string; data: Record<string, unknown> }) {
  const { t } = useTranslation();
  return (
    <Collapsible>
      <CollapsibleTrigger className="flex items-center gap-2 w-full py-2 text-sm font-medium hover:text-foreground text-muted-foreground">
        <ChevronDownIcon className="size-4 transition-transform [[data-state=closed]_&]:-rotate-90" />
        <LockIcon className="size-3" />
        {label}
        <Badge variant="secondary" className="ml-auto text-xs">
          {t("config.readOnly", "Read-only")}
        </Badge>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pl-6 pb-3 space-y-1">
          {Object.entries(data).map(([key, val]) => (
            <div
              key={key}
              className="flex items-center justify-between py-1 border-b border-border/30 last:border-0"
            >
              <span className="text-sm text-muted-foreground">{key}</span>
              <span className="text-sm font-mono truncate max-w-[60%]">
                {val === null || val === undefined
                  ? "null"
                  : typeof val === "object"
                    ? JSON.stringify(val)
                    : String(val)}
              </span>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function StaticConfigCard() {
  const { t } = useTranslation();
  const [data, setData] = useState<StaticConfigData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/settings");
        const json = await res.json();
        setData(json.data);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          {t("common.loading", "Loading...")}
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  const sections: Array<{ label: string; data: Record<string, unknown> }> = [
    { label: t("config.static.general", "General"), data: data.general },
    { label: t("config.static.database", "Database"), data: data.database },
    { label: t("config.static.ai", "AI Service"), data: data.ai },
    { label: t("config.static.auth", "Authentication"), data: data.auth },
    { label: t("config.static.tenancy", "Tenancy"), data: data.tenancy },
    { label: t("config.static.server", "Server"), data: data.server },
    { label: t("config.static.subscription", "Subscriptions"), data: data.subscription },
    { label: t("config.static.flow", "Flow Engine"), data: data.flow },
  ];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <LockIcon className="size-4 text-muted-foreground" />
          <div>
            <CardTitle className="text-base font-semibold">
              {t("config.staticConfig", "Static Configuration")}
            </CardTitle>
            <CardDescription>
              {t(
                "config.staticConfigDesc",
                "Loaded from linchkit.config.ts at startup. Requires restart to change.",
              )}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-1">
          {sections.map((s) => (
            <StaticConfigSection key={s.label} label={s.label} data={s.data} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ── ConfigStore KV Section ──────────────────────────────

const SCOPE_OPTIONS: ConfigStoreScope[] = ["global", "tenant", "department", "user"];

function ScopeSelector({
  value,
  onChange,
}: {
  value: ConfigStoreScope;
  onChange: (v: ConfigStoreScope) => void;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as ConfigStoreScope)}>
      <SelectTrigger className="w-32 h-8 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SCOPE_OPTIONS.map((s) => (
          <SelectItem key={s} value={s}>
            {s}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Format a value for display */
function formatValue(val: unknown): string {
  if (val === null || val === undefined) return "(empty)";
  if (typeof val === "object") return JSON.stringify(val, null, 2);
  return String(val);
}

/** Detect the value type for editing */
function detectValueType(val: unknown): "boolean" | "number" | "string" | "json" {
  if (typeof val === "boolean") return "boolean";
  if (typeof val === "number") return "number";
  if (typeof val === "object" && val !== null) return "json";
  return "string";
}

// ── KV Entry Row with inline editing and history ────────

function KVEntryRow({
  entry,
  namespace,
  onRefresh,
}: {
  entry: ConfigStoreEntry;
  namespace: string;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<ConfigStoreVersion[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);

  const valType = detectValueType(entry.value);

  const startEdit = useCallback(() => {
    setEditing(true);
    setEditValue(
      valType === "json" ? JSON.stringify(entry.value, null, 2) : String(entry.value ?? ""),
    );
    setError(null);
  }, [entry.value, valType]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      let parsed: unknown = editValue;
      if (valType === "json") {
        parsed = JSON.parse(editValue);
      } else if (valType === "number") {
        parsed = Number(editValue);
      } else if (valType === "boolean") {
        parsed = editValue === "true";
      }
      const scope: ConfigStoreScopeRef = { type: entry.scope, id: entry.scopeId };
      await setConfigStoreValue(namespace, entry.key, parsed, { scope });
      setEditing(false);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [namespace, entry.key, entry.scope, entry.scopeId, editValue, valType, onRefresh]);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    try {
      await deleteConfigStoreEntry(namespace, entry.key, {
        type: entry.scope,
        id: entry.scopeId,
      });
      onRefresh();
    } finally {
      setDeleting(false);
    }
  }, [namespace, entry.key, entry.scope, entry.scopeId, onRefresh]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const items = await fetchConfigStoreHistory(namespace, entry.key, {
        type: entry.scope,
        id: entry.scopeId,
      });
      setHistory(items);
    } finally {
      setHistoryLoading(false);
    }
  }, [namespace, entry.key, entry.scope, entry.scopeId]);

  const toggleHistory = useCallback(() => {
    const next = !showHistory;
    setShowHistory(next);
    if (next && history.length === 0) {
      loadHistory();
    }
  }, [showHistory, history.length, loadHistory]);

  const handleRollback = useCallback(
    async (version: number) => {
      setRollingBack(true);
      try {
        await rollbackConfigStoreEntry(namespace, entry.key, version, {
          scope: { type: entry.scope, id: entry.scopeId },
          reason: `Rollback to v${version}`,
        });
        onRefresh();
        loadHistory();
      } finally {
        setRollingBack(false);
      }
    },
    [namespace, entry.key, entry.scope, entry.scopeId, onRefresh, loadHistory],
  );

  return (
    <div className="border rounded-md">
      <div className="flex items-center gap-3 px-3 py-2">
        {/* Key */}
        <code className="text-sm font-semibold min-w-[120px]">{entry.key}</code>

        {/* Scope badge */}
        <Badge variant="outline" className="text-xs shrink-0">
          {entry.scope}
          {entry.scopeId ? `:${entry.scopeId}` : ""}
        </Badge>

        {entry.encrypted && (
          <Badge variant="secondary" className="text-xs shrink-0">
            <LockIcon className="size-3 mr-0.5" />
            {t("config.encrypted", "Encrypted")}
          </Badge>
        )}

        {/* Value display or edit */}
        <div className="flex-1 min-w-0">
          {editing ? (
            <div className="flex items-center gap-2">
              {valType === "boolean" ? (
                <Select value={editValue} onValueChange={setEditValue}>
                  <SelectTrigger className="h-7 text-xs w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">true</SelectItem>
                    <SelectItem value="false">false</SelectItem>
                  </SelectContent>
                </Select>
              ) : valType === "json" ? (
                <Textarea
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  rows={3}
                  className="font-mono text-xs"
                />
              ) : (
                <Input
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  type={valType === "number" ? "number" : "text"}
                  className="h-7 text-xs"
                />
              )}
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                onClick={handleSave}
                disabled={saving}
              >
                <SaveIcon className="size-3" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                onClick={() => setEditing(false)}
              >
                <XIcon className="size-3" />
              </Button>
            </div>
          ) : (
            <button
              type="button"
              className="text-sm font-mono truncate block w-full text-left hover:text-foreground text-muted-foreground cursor-pointer"
              onClick={startEdit}
              title={t("config.clickToEdit", "Click to edit")}
            >
              {formatValue(entry.value)}
            </button>
          )}
        </div>

        {/* Updated time */}
        <span className="text-xs text-muted-foreground shrink-0">
          {new Date(entry.updatedAt).toLocaleString()}
        </span>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="sm" variant="ghost" className="h-7 px-1.5" onClick={toggleHistory}>
                  <HistoryIcon className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("config.versionHistory", "Version history")}</TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-1.5 text-destructive"
                  onClick={handleDelete}
                  disabled={deleting}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("common.delete", "Delete")}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      {error && (
        <div className="px-3 pb-2">
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      )}

      {/* Version history panel */}
      {showHistory && (
        <div className="border-t px-3 py-2 bg-muted/30">
          <h4 className="text-xs font-semibold mb-2 text-muted-foreground">
            {t("config.versionHistory", "Version history")}
          </h4>
          {historyLoading ? (
            <p className="text-xs text-muted-foreground py-2">
              {t("common.loading", "Loading...")}
            </p>
          ) : history.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">
              {t("config.noHistory", "No changes recorded yet.")}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">V#</TableHead>
                  <TableHead className="text-xs">{t("config.configValue", "Value")}</TableHead>
                  <TableHead className="text-xs">{t("config.changedAt", "Changed At")}</TableHead>
                  <TableHead className="text-xs">{t("config.changedBy", "Changed By")}</TableHead>
                  <TableHead className="text-xs">{t("config.reason", "Reason")}</TableHead>
                  <TableHead className="text-xs" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((ver) => (
                  <TableRow key={ver.id}>
                    <TableCell className="text-xs font-mono">v{ver.version}</TableCell>
                    <TableCell className="text-xs font-mono truncate max-w-[200px]">
                      {formatValue(ver.value)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(ver.changedAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {ver.changedBy ?? "-"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {ver.changeReason ?? "-"}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-1.5 text-xs"
                        onClick={() => handleRollback(ver.version)}
                        disabled={rollingBack}
                      >
                        <RotateCcwIcon className="size-3 mr-0.5" />
                        {t("config.rollback", "Rollback")}
                      </Button>
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

// ── New KV Entry Dialog ─────────────────────────────────

function NewKVEntryDialog({
  open,
  onOpenChange,
  namespace,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  namespace: string;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [scope, setScope] = useState<ConfigStoreScope>("global");
  const [scopeId, setScopeId] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = useCallback(async () => {
    if (!key.trim()) return;
    setSaving(true);
    setError(null);
    try {
      let parsed: unknown = value;
      try {
        parsed = JSON.parse(value);
      } catch {
        // Keep as string
      }
      await setConfigStoreValue(namespace, key.trim(), parsed, {
        scope: { type: scope, id: scopeId || undefined },
        reason: reason || undefined,
      });
      onCreated();
      onOpenChange(false);
      // Reset form
      setKey("");
      setValue("");
      setScope("global");
      setScopeId("");
      setReason("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [key, value, scope, scopeId, reason, namespace, onCreated, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("config.newEntry", "New Config Entry")}</DialogTitle>
          <DialogDescription>
            {t("config.newEntryDesc", "Add a new key-value config entry to namespace {{ns}}.", {
              ns: namespace,
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>{t("config.key", "Key")}</Label>
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="e.g. default_model"
            />
          </div>
          <div className="space-y-1">
            <Label>{t("config.configValue", "Value")}</Label>
            <Textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              rows={3}
              className="font-mono text-sm"
              placeholder='e.g. "gpt-4" or {"key": "value"}'
            />
          </div>
          <div className="flex gap-3">
            <div className="space-y-1 flex-1">
              <Label>{t("config.scope", "Scope")}</Label>
              <ScopeSelector value={scope} onChange={setScope} />
            </div>
            {scope !== "global" && (
              <div className="space-y-1 flex-1">
                <Label>{t("config.scopeId", "Scope ID")}</Label>
                <Input
                  value={scopeId}
                  onChange={(e) => setScopeId(e.target.value)}
                  placeholder="e.g. tenant-123"
                  className="h-8 text-sm"
                />
              </div>
            )}
          </div>
          <div className="space-y-1">
            <Label>{t("config.reason", "Reason")}</Label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("config.reasonPlaceholder", "Optional change reason")}
            />
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel", "Cancel")}
          </Button>
          <Button onClick={handleCreate} disabled={saving || !key.trim()}>
            {saving ? t("common.saving", "Saving...") : t("common.create", "Create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── ConfigStore Namespace Panel ─────────────────────────

function ConfigStoreNamespacePanel({ namespace, active }: { namespace: string; active: boolean }) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<ConfigStoreEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [showNewDialog, setShowNewDialog] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const items = await fetchConfigStoreEntries(namespace);
      setEntries(items);
    } finally {
      setLoading(false);
    }
  }, [namespace]);

  useEffect(() => {
    if (active) load();
  }, [active, load]);

  if (!active) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          {namespace}{" "}
          <Badge variant="outline" className="ml-2 text-xs">
            {entries.length} {t("config.entries", "entries")}
          </Badge>
        </h3>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={load} disabled={loading}>
            <RefreshCwIcon className={`size-3 mr-1 ${loading ? "animate-spin" : ""}`} />
            {t("common.refresh", "Refresh")}
          </Button>
          <Button size="sm" onClick={() => setShowNewDialog(true)}>
            <PlusIcon className="size-3 mr-1" />
            {t("config.addEntry", "Add Entry")}
          </Button>
        </div>
      </div>

      {loading && entries.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-6">
          {t("common.loading", "Loading...")}
        </p>
      ) : entries.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <DatabaseIcon className="size-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm">
            {t("config.emptyNamespace", "No entries in this namespace yet.")}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={() => setShowNewDialog(true)}
          >
            <PlusIcon className="size-3 mr-1" />
            {t("config.addFirstEntry", "Add first entry")}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => (
            <KVEntryRow key={entry.id} entry={entry} namespace={namespace} onRefresh={load} />
          ))}
        </div>
      )}

      <NewKVEntryDialog
        open={showNewDialog}
        onOpenChange={setShowNewDialog}
        namespace={namespace}
        onCreated={load}
      />
    </div>
  );
}

// ── ConfigStore Section ─────────────────────────────────

function ConfigStoreSection() {
  const { t } = useTranslation();
  const [namespaces, setNamespaces] = useState<string[]>(["ai", "notification", "ui"]);
  const [activeNs, setActiveNs] = useState<string>("ai");
  const [newNs, setNewNs] = useState("");
  const [showNewNsInput, setShowNewNsInput] = useState(false);

  const addNamespace = useCallback(() => {
    const ns = newNs.trim();
    if (ns && !namespaces.includes(ns)) {
      setNamespaces((prev) => [...prev, ns]);
      setActiveNs(ns);
    }
    setNewNs("");
    setShowNewNsInput(false);
  }, [newNs, namespaces]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <DatabaseIcon className="size-4 text-muted-foreground" />
          <div>
            <CardTitle className="text-base font-semibold">
              {t("config.kvStore", "Dynamic Config Store")}
            </CardTitle>
            <CardDescription>
              {t(
                "config.kvStoreDesc",
                "Key-value configuration with scope cascade (global > tenant > department > user) and version history.",
              )}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex gap-4">
          {/* Namespace sidebar */}
          <div className="w-48 shrink-0 space-y-1">
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
              {t("config.namespaces", "Namespaces")}
            </div>
            {namespaces.map((ns) => (
              <button
                key={ns}
                type="button"
                className={`w-full text-left text-sm px-2.5 py-1.5 rounded-md transition-colors ${
                  activeNs === ns
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-muted text-muted-foreground"
                }`}
                onClick={() => setActiveNs(ns)}
              >
                {ns}
              </button>
            ))}
            <Separator className="my-2" />
            {showNewNsInput ? (
              <div className="flex gap-1">
                <Input
                  value={newNs}
                  onChange={(e) => setNewNs(e.target.value)}
                  placeholder="namespace"
                  className="h-7 text-xs"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addNamespace();
                    if (e.key === "Escape") setShowNewNsInput(false);
                  }}
                  autoFocus
                />
                <Button size="sm" variant="ghost" className="h-7 px-1.5" onClick={addNamespace}>
                  <CheckCircleIcon className="size-3" />
                </Button>
              </div>
            ) : (
              <button
                type="button"
                className="w-full text-left text-xs px-2.5 py-1.5 text-muted-foreground hover:text-foreground"
                onClick={() => setShowNewNsInput(true)}
              >
                <PlusIcon className="size-3 inline mr-1" />
                {t("config.addNamespace", "Add namespace")}
              </button>
            )}
          </div>

          {/* Content area */}
          <div className="flex-1 min-w-0">
            {namespaces.map((ns) => (
              <ConfigStoreNamespacePanel key={ns} namespace={ns} active={ns === activeNs} />
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main Page ───────────────────────────────────────────

export function ConfigCenterPage() {
  const { t } = useTranslation();
  const [configs, setConfigs] = useState<ConfigItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("runtime");

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

  const refreshConfig = useCallback(async (name: string) => {
    const updated = await fetchConfig(name);
    if (updated) {
      setConfigs((prev) => prev.map((c) => (c.name === name ? updated : c)));
    }
  }, []);

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t("config.title", "Config Center")}</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {t(
              "config.subtitle",
              "Manage static, runtime, and dynamic configuration in one place.",
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

      {/* Tabs for config layers */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="runtime">
            <SettingsIcon className="size-3 mr-1" />
            {t("config.runtimeTab", "Runtime Config")}
          </TabsTrigger>
          <TabsTrigger value="kvstore">
            <DatabaseIcon className="size-3 mr-1" />
            {t("config.kvStoreTab", "Dynamic KV Store")}
          </TabsTrigger>
          <TabsTrigger value="static">
            <LockIcon className="size-3 mr-1" />
            {t("config.staticTab", "Static Config")}
          </TabsTrigger>
        </TabsList>

        {/* Runtime config — structured fields */}
        <TabsContent value="runtime" className="space-y-4">
          {loading && (
            <p className="text-sm text-muted-foreground text-center py-8">
              {t("common.loading", "Loading...")}
            </p>
          )}
          {!loading && configs.length === 0 && (
            <Card>
              <CardContent className="py-12 text-center">
                <SettingsIcon className="size-10 text-muted-foreground mx-auto mb-3" />
                <p className="text-muted-foreground">
                  {t("config.empty", "No config namespaces registered yet.")}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {t(
                    "config.emptyHint",
                    "Capabilities can register runtime config definitions to appear here.",
                  )}
                </p>
              </CardContent>
            </Card>
          )}
          {!loading &&
            configs.map((config) => (
              <RuntimeConfigCard
                key={config.name}
                config={config}
                onSaved={() => refreshConfig(config.name)}
              />
            ))}
        </TabsContent>

        {/* Dynamic KV config store */}
        <TabsContent value="kvstore">
          <ConfigStoreSection />
        </TabsContent>

        {/* Static config (read-only) */}
        <TabsContent value="static">
          <StaticConfigCard />
        </TabsContent>
      </Tabs>
    </div>
  );
}
