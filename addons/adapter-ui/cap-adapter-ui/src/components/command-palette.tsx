/**
 * CommandPalette — Global command palette triggered by Cmd+K / Ctrl+K.
 *
 * Features:
 * - Navigate to pages (Workspace, Executions, Settings, etc.)
 * - Search and jump to any registered schema
 * - AI Search mode: type natural language queries to filter schema data
 * - Theme switching (light / dark / system)
 * - Global keyboard shortcut: Cmd+K / Ctrl+K to toggle
 *
 * Spec ref: 13_view_and_ui.md §2.3 Intent Preview, §9.2 Top Command Bar.
 */

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@linchkit/ui-kit/components";
import { useTheme } from "@linchkit/ui-kit/hooks";
import {
  DatabaseIcon,
  LayoutDashboardIcon,
  Loader2Icon,
  MonitorIcon,
  MoonIcon,
  ScrollTextIcon,
  ShieldCheckIcon,
  SparklesIcon,
  SunIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isNaturalLanguageQuery } from "@/hooks/use-ai-search";
import { useEntities } from "@/hooks/use-entities";
import { useSchemaLabel } from "@/i18n/use-entity-label";
import { aiSearch } from "@/lib/api";
import { getLucideIcon } from "@/lib/dynamic-icon";

interface CommandPaletteProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function CommandPalette({ open: controlledOpen, onOpenChange }: CommandPaletteProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const { t } = useTranslation();
  const { schemas } = useEntities();
  const { resolveLabel } = useSchemaLabel();
  const { theme, setTheme } = useTheme();

  // AI search state within the palette
  const [aiMode, setAiMode] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState<string | null>(null);
  const [aiQuery, setAiQuery] = useState("");
  const inputValueRef = useRef("");

  const setOpen = useCallback(
    (value: boolean) => {
      setInternalOpen(value);
      onOpenChange?.(value);
      if (!value) {
        // Reset AI mode when closing
        setAiMode(false);
        setAiLoading(false);
        setAiResult(null);
        setAiQuery("");
      }
    },
    [onOpenChange],
  );

  // Cmd+K / Ctrl+K to toggle the palette
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(!open);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, [open, setOpen]);

  const runCommand = useCallback(
    (cb: () => void) => {
      setOpen(false);
      cb();
    },
    [setOpen],
  );

  const navigate = useCallback(
    (href: string) => {
      runCommand(() => {
        window.history.pushState({}, "", href);
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
    },
    [runCommand],
  );

  // Stable ref for navigate to avoid stale closure in handleAISearch
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // Handle AI search execution from the palette
  const handleAISearch = useCallback(
    async (query: string, schemaName: string) => {
      setAiLoading(true);
      setAiResult(null);
      setAiQuery(query);
      try {
        const result = await aiSearch({
          query,
          schema: schemaName,
          fields: {},
        });
        if (result) {
          setAiResult(result.explanation);
          // Navigate to the schema page — the AI filter will be applied via URL or state
          // For now, navigate and show the explanation
          setTimeout(() => {
            navigateRef.current(`/schemas/${schemaName}`);
          }, 1500);
        } else {
          setAiResult(t("aiSearch.notConfigured", "AI service is not configured."));
        }
      } catch {
        setAiResult(t("aiSearch.error", "AI search failed. Please try again."));
      } finally {
        setAiLoading(false);
      }
    },
    [t],
  );

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title={t("commandPalette.title")}
      description={t("commandPalette.description")}
    >
      <CommandInput
        placeholder={
          aiMode
            ? t("aiSearch.palettePlaceholder", "Describe what you're looking for...")
            : t("commandPalette.placeholder")
        }
        onValueChange={(v) => {
          inputValueRef.current = v;
        }}
      />
      <CommandList>
        <CommandEmpty>{t("commandPalette.noResults")}</CommandEmpty>

        {/* AI Search mode items */}
        {aiMode ? (
          <>
            {aiLoading && (
              <CommandGroup heading={t("aiSearch.processing", "Processing...")}>
                <CommandItem disabled>
                  <Loader2Icon className="animate-spin" />
                  <span>{t("aiSearch.analyzing", "Analyzing your query...")}</span>
                </CommandItem>
              </CommandGroup>
            )}
            {aiResult && (
              <CommandGroup heading={t("aiSearch.resultTitle", "AI Search Result")}>
                <CommandItem disabled>
                  <SparklesIcon />
                  <span>{aiResult}</span>
                </CommandItem>
              </CommandGroup>
            )}
            {!aiLoading && !aiResult && (
              <CommandGroup heading={t("aiSearch.selectSchema", "Select a schema to search")}>
                {schemas.map((schema) => {
                  const Icon = getLucideIcon(schema.icon) ?? DatabaseIcon;
                  return (
                    <CommandItem
                      key={schema.name}
                      onSelect={() => {
                        const query = inputValueRef.current || aiQuery;
                        if (query) {
                          handleAISearch(query, schema.name);
                        }
                      }}
                    >
                      <Icon />
                      <span>
                        {t("aiSearch.searchIn", "Search in {{schema}}", {
                          schema: resolveLabel(schema.label, schema.name),
                        })}
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
          </>
        ) : (
          <>
            {/* AI Search entry point */}
            <CommandGroup heading={t("aiSearch.title", "AI Search")}>
              <CommandItem
                onSelect={() => {
                  const currentValue = inputValueRef.current;
                  if (currentValue && isNaturalLanguageQuery(currentValue)) {
                    setAiMode(true);
                    setAiQuery(currentValue);
                  } else {
                    setAiMode(true);
                  }
                }}
              >
                <SparklesIcon />
                <span>{t("aiSearch.paletteAction", "AI Search — natural language filter")}</span>
              </CommandItem>
            </CommandGroup>

            <CommandSeparator />

            {/* Navigation commands */}
            <CommandGroup heading={t("commandPalette.navigation")}>
              <CommandItem onSelect={() => navigate("/")}>
                <LayoutDashboardIcon />
                <span>{t("nav.workspace")}</span>
              </CommandItem>
              <CommandItem onSelect={() => navigate("/schemas/execution_log")}>
                <ScrollTextIcon />
                <span>{t("executionLog.title")}</span>
              </CommandItem>
              <CommandItem onSelect={() => navigate("/admin/system")}>
                <MonitorIcon />
                <span>{t("systemOverview.title")}</span>
              </CommandItem>
              <CommandItem onSelect={() => navigate("/schemas/rule")}>
                <ShieldCheckIcon />
                <span>{t("rules.title")}</span>
              </CommandItem>
            </CommandGroup>

            {/* Dynamic schema list */}
            {schemas.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading={t("commandPalette.schemas")}>
                  {schemas.map((schema) => {
                    const Icon = getLucideIcon(schema.icon) ?? DatabaseIcon;
                    return (
                      <CommandItem
                        key={schema.name}
                        onSelect={() => navigate(`/schemas/${schema.name}`)}
                      >
                        <Icon />
                        <span>{resolveLabel(schema.label, schema.name)}</span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </>
            )}

            <CommandSeparator />

            {/* Theme preferences */}
            <CommandGroup heading={t("commandPalette.preferences")}>
              {theme !== "light" && (
                <CommandItem onSelect={() => runCommand(() => setTheme("light"))}>
                  <SunIcon />
                  <span>{t("commandPalette.switchToLight")}</span>
                </CommandItem>
              )}
              {theme !== "dark" && (
                <CommandItem onSelect={() => runCommand(() => setTheme("dark"))}>
                  <MoonIcon />
                  <span>{t("commandPalette.switchToDark")}</span>
                </CommandItem>
              )}
              {theme !== "system" && (
                <CommandItem onSelect={() => runCommand(() => setTheme("system"))}>
                  <MonitorIcon />
                  <span>{t("commandPalette.switchToSystem")}</span>
                </CommandItem>
              )}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
