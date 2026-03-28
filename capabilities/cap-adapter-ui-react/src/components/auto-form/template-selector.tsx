/**
 * TemplateSelector — dropdown to pick a record template in create mode.
 *
 * Displayed above the form fields when templates are available.
 * Selecting a template pre-fills form fields; user can override before submit.
 */

import type { RecordTemplate } from "@linchkit/core/types";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@linchkit/ui-kit/components";
import { ChevronDown, FileText, LayoutTemplate, X } from "lucide-react";
import { useTranslation } from "react-i18next";

interface TemplateSelectorProps {
  templates: RecordTemplate[];
  /** Called when user picks a template to apply */
  onSelect: (template: RecordTemplate) => void;
  /** Called when user clears the applied template (resets fields to defaults) */
  onClear: () => void;
  /** ID of the currently applied template, if any */
  selectedId?: string;
}

export function TemplateSelector({
  templates,
  onSelect,
  onClear,
  selectedId,
}: TemplateSelectorProps) {
  const { t } = useTranslation();

  if (templates.length === 0) return null;

  const selected = templates.find((tmpl) => tmpl.id === selectedId);

  return (
    <div className="mb-4 flex items-center gap-2 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2">
      <LayoutTemplate className="size-4 shrink-0 text-muted-foreground" />
      <span className="text-sm text-muted-foreground">
        {t("form.template.label", "Template")}:
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 gap-1 text-sm bg-background">
            {selected ? (
              <>
                <FileText className="size-3.5" />
                {selected.name}
              </>
            ) : (
              <span className="text-muted-foreground">
                {t("form.template.none", "Blank record")}
              </span>
            )}
            <ChevronDown className="size-3.5 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
            {t("form.template.selectLabel", "Pre-fill from template")}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {templates.map((template) => (
            <DropdownMenuItem
              key={template.id}
              onSelect={() => onSelect(template)}
              className="flex flex-col items-start gap-0.5 py-2"
            >
              <div className="flex items-center gap-1.5">
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="font-medium">{template.name}</span>
              </div>
              {template.description && (
                <span className="pl-5 text-xs text-muted-foreground line-clamp-1">
                  {template.description}
                </span>
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {selected && (
        <button
          type="button"
          className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={onClear}
        >
          <X className="size-3" />
          {t("form.template.clear", "Clear")}
        </button>
      )}
    </div>
  );
}
