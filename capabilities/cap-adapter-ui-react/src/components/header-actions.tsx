/**
 * HeaderActions — Right side of the top header bar.
 *
 * Contains: Command Palette trigger, notifications, language, theme toggles.
 * Spec ref: 13_view_and_ui.md §9.2 Top Command Bar.
 */

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@linchkit/ui-kit/components";
import { useTheme } from "@linchkit/ui-kit/hooks";
import { GlobeIcon, MonitorIcon, MoonIcon, SearchIcon, SparklesIcon, SunIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { changeLanguage, languageNames, type SupportedLanguage, supportedLanguages } from "@/i18n";
import { NotificationCenter } from "./notification-center";
import { TenantSwitcher } from "./tenant-switcher";

export function HeaderActions({
  onOpenCommandPalette,
  onToggleAI,
}: {
  onOpenCommandPalette?: () => void;
  onToggleAI?: () => void;
}) {
  const { theme, setTheme } = useTheme();
  const { i18n, t } = useTranslation();
  const currentLang = i18n.language as SupportedLanguage;

  const ThemeIcon = theme === "dark" ? MoonIcon : theme === "light" ? SunIcon : MonitorIcon;

  const cycleTheme = () => {
    const order = { light: "dark", dark: "system", system: "light" } as const;
    setTheme(order[theme]);
  };

  return (
    <div className="flex items-center gap-1">
      {/* Tenant switcher */}
      <TenantSwitcher />

      {/* Command Palette trigger */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-2 text-muted-foreground"
            onClick={onOpenCommandPalette}
          >
            <SearchIcon className="size-4" />
            <span className="hidden text-xs sm:inline-flex">{t("commandPalette.placeholder")}</span>
            <kbd className="pointer-events-none hidden h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground sm:inline-flex">
              <span className="text-xs">⌘</span>K
            </kbd>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("commandPalette.title")}</TooltipContent>
      </Tooltip>

      {/* Notifications */}
      <NotificationCenter />

      {/* AI Assistant toggle */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            onClick={onToggleAI}
          >
            <SparklesIcon className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("ai.title")}</TooltipContent>
      </Tooltip>

      {/* Language switcher */}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="text-muted-foreground">
                <GlobeIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>{t("language.label")}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          {supportedLanguages.map((lang) => (
            <DropdownMenuItem
              key={lang}
              onClick={() => changeLanguage(lang)}
              className={lang === currentLang ? "font-semibold" : ""}
            >
              {languageNames[lang]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Theme toggle */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            onClick={cycleTheme}
          >
            <ThemeIcon className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {theme === "dark" ? t("theme.dark", "Dark") : theme === "light" ? t("theme.light", "Light") : t("theme.system", "System")}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
