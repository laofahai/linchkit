/**
 * LanguageSwitcher — Dropdown to switch between supported languages.
 */

import { useTranslation } from "react-i18next";
import { GlobeIcon } from "lucide-react";
import {
	changeLanguage,
	supportedLanguages,
	languageNames,
	type SupportedLanguage,
} from "../i18n";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	SidebarMenuButton,
} from "@/components/ui/sidebar";

export function LanguageSwitcher() {
	const { i18n, t } = useTranslation();
	const currentLang = i18n.language as SupportedLanguage;

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<SidebarMenuButton size="sm" tooltip={t("language.label")}>
					<GlobeIcon className="h-4 w-4" />
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
