/**
 * LanguageSwitcher — Dropdown to switch between supported languages.
 */

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  SidebarMenuButton,
} from "@linchkit/ui-kit/components";
import { GlobeIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { changeLanguage, languageNames, type SupportedLanguage, supportedLanguages } from "../i18n";

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation();
  const currentLang = i18n.language as SupportedLanguage;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton size="sm" tooltip={t("language.label")}>
          <GlobeIcon className="size-4" />
          <span>{languageNames[currentLang] ?? currentLang}</span>
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end" sideOffset={4}>
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
  );
}
