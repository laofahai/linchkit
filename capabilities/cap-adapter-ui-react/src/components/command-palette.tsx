/**
 * CommandPalette — Global command palette triggered by Cmd+K / Ctrl+K.
 *
 * Features:
 * - Navigate to pages (Workspace, Executions, Settings, etc.)
 * - Search and jump to any registered schema
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
  CommandShortcut,
} from "@linchkit/ui-kit/components";
import { useTheme } from "@linchkit/ui-kit/hooks";
import {
  ActivityIcon,
  BlocksIcon,
  DatabaseIcon,
  HeartPulseIcon,
  LayoutDashboardIcon,
  MonitorIcon,
  MoonIcon,
  ScrollTextIcon,
  Settings2Icon,
  SunIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSchemas } from "@/hooks/use-schemas";

interface CommandPaletteProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function CommandPalette({ open: controlledOpen, onOpenChange }: CommandPaletteProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const { t } = useTranslation();
  const { schemas } = useSchemas();
  const { theme, setTheme } = useTheme();

  const setOpen = useCallback(
    (value: boolean) => {
      setInternalOpen(value);
      onOpenChange?.(value);
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

  const runCommand = (cb: () => void) => {
    setOpen(false);
    cb();
  };

  const navigate = (href: string) => {
    runCommand(() => {
      // Use history.pushState + popstate to trigger TanStack Router navigation
      // without needing router context (avoids portal context issues)
      window.history.pushState({}, "", href);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title={t("commandPalette.title")}
      description={t("commandPalette.description")}
    >
      <CommandInput placeholder={t("commandPalette.placeholder")} />
      <CommandList>
        <CommandEmpty>{t("commandPalette.noResults")}</CommandEmpty>

        {/* Navigation commands */}
        <CommandGroup heading={t("commandPalette.navigation")}>
          <CommandItem onSelect={() => navigate("/")}>
            <LayoutDashboardIcon />
            <span>{t("nav.workspace")}</span>
          </CommandItem>
          <CommandItem onSelect={() => navigate("/modules")}>
            <BlocksIcon />
            <span>{t("nav.capabilities")}</span>
          </CommandItem>
          <CommandItem onSelect={() => navigate("/admin/events")}>
            <ActivityIcon />
            <span>{t("nav.events")}</span>
          </CommandItem>
          <CommandItem onSelect={() => navigate("/admin/executions")}>
            <ScrollTextIcon />
            <span>{t("executionLog.title")}</span>
          </CommandItem>
          <CommandItem onSelect={() => navigate("/admin/health")}>
            <HeartPulseIcon />
            <span>{t("health.title")}</span>
          </CommandItem>
          <CommandItem onSelect={() => navigate("/admin/settings")}>
            <Settings2Icon />
            <span>{t("nav.settings")}</span>
            <CommandShortcut>{t("commandPalette.shortcutSettings")}</CommandShortcut>
          </CommandItem>
        </CommandGroup>

        {/* Dynamic schema list — shows all registered schemas */}
        {schemas.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t("commandPalette.schemas")}>
              {schemas.map((schema) => (
                <CommandItem
                  key={schema.name}
                  onSelect={() => navigate(`/schemas/${schema.name}`)}
                >
                  <DatabaseIcon />
                  <span>{schema.label ?? schema.name}</span>
                </CommandItem>
              ))}
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
      </CommandList>
    </CommandDialog>
  );
}
