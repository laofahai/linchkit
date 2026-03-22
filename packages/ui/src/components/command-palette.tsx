/**
 * CommandPalette — Global command palette triggered by Cmd+K / Ctrl+K.
 *
 * Provides quick navigation, search, and action launching.
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
import {
  ActivityIcon,
  BlocksIcon,
  DatabaseIcon,
  LayoutDashboardIcon,
  ScrollTextIcon,
  Settings2Icon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

interface CommandPaletteProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function CommandPalette({ open: controlledOpen, onOpenChange }: CommandPaletteProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const { t } = useTranslation();

  const setOpen = useCallback(
    (value: boolean) => {
      setInternalOpen(value);
      onOpenChange?.(value);
    },
    [onOpenChange],
  );

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

  const runCommand = (href: string) => {
    setOpen(false);
    // Use history.pushState + popstate to trigger TanStack Router navigation
    // without needing router context (avoids portal context issues)
    window.history.pushState({}, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
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

        <CommandGroup heading={t("commandPalette.navigation")}>
          <CommandItem onSelect={() => runCommand("/")}>
            <LayoutDashboardIcon />
            <span>{t("nav.home")}</span>
          </CommandItem>
          <CommandItem onSelect={() => runCommand("/modules")}>
            <BlocksIcon />
            <span>{t("nav.capabilities")}</span>
          </CommandItem>
          <CommandItem onSelect={() => runCommand("/schemas/purchase_request")}>
            <DatabaseIcon />
            <span>{t("nav.schemas")}</span>
          </CommandItem>
          <CommandItem onSelect={() => runCommand("/admin/events")}>
            <ActivityIcon />
            <span>{t("nav.events")}</span>
          </CommandItem>
          <CommandItem onSelect={() => runCommand("/admin/executions")}>
            <ScrollTextIcon />
            <span>{t("executionLog.title")}</span>
          </CommandItem>
          <CommandItem onSelect={() => runCommand("/admin/settings")}>
            <Settings2Icon />
            <span>{t("nav.settings")}</span>
            <CommandShortcut>{t("commandPalette.shortcutSettings")}</CommandShortcut>
          </CommandItem>
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading={t("commandPalette.actions")}>
          <CommandItem disabled>
            <span className="text-muted-foreground">{t("commandPalette.actionsComingSoon")}</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
