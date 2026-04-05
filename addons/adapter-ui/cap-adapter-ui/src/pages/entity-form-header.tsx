/**
 * Schema form page — control panel header bar.
 *
 * Contains: back button, business action buttons, edit/save/cancel,
 * AI auto-fill button, overflow menu (duplicate, delete, print).
 */

import type { ViewAction } from "@linchkit/core/types";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Separator,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@linchkit/ui-kit/components";
import {
  ArrowLeft,
  Copy,
  Loader2,
  MoreHorizontal,
  Pencil,
  Printer,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { TFunction } from "i18next";

export interface EntityFormHeaderProps {
  t: TFunction;
  entityName: string;
  recordId: string | undefined;
  isCreate: boolean;
  isEditing: boolean;
  isInternal: boolean;
  saving: boolean;
  businessActions: ViewAction[];
  isActionEnabled: (actionName: string) => { enabled: boolean; reason?: string };
  resolveLabel: (label: string | undefined, fallback: string) => string;
  onBack: () => void;
  onAction: (actionName: string) => void;
  onEdit: () => void;
  onCancel: () => void;
  onPrint: () => void;
  onDuplicate: () => void;
  onDeleteOpen: () => void;
  /** AI auto-fill */
  aiEnabled: boolean;
  aiLoading: boolean;
  onAiFill: () => void;
}

export function EntityFormHeader({
  t,
  isCreate,
  isEditing,
  isInternal,
  saving,
  businessActions,
  isActionEnabled,
  resolveLabel,
  onBack,
  onAction,
  onEdit,
  onCancel,
  onPrint,
  onDuplicate,
  onDeleteOpen,
  aiEnabled,
  aiLoading,
  onAiFill,
}: EntityFormHeaderProps) {
  return (
    <div className="sticky top-0 z-10 bg-background border-b px-4 py-2">
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="icon" className="shrink-0" onClick={onBack}>
          <ArrowLeft className="size-4" />
        </Button>

        <TooltipProvider delayDuration={300}>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {businessActions.map((a) => {
              const { enabled, reason } = isActionEnabled(a.action);
              const isDisabled = saving || !enabled;
              const btn = (
                <Button
                  key={a.action}
                  size="sm"
                  variant={
                    a.variant === "destructive"
                      ? "destructive"
                      : a.variant === "ghost"
                        ? "ghost"
                        : "default"
                  }
                  disabled={isDisabled}
                  onClick={() => onAction(a.action)}
                >
                  {resolveLabel(a.label, a.action)}
                </Button>
              );
              if (isDisabled && reason) {
                return (
                  <Tooltip key={a.action}>
                    <TooltipTrigger asChild>
                      <span className="inline-flex">{btn}</span>
                    </TooltipTrigger>
                    <TooltipContent>{reason}</TooltipContent>
                  </Tooltip>
                );
              }
              return btn;
            })}

            {!isCreate && !isEditing && businessActions.length > 0 && (
              <Separator orientation="vertical" className="!self-auto h-5 mx-1 hidden md:block" />
            )}

            {!isCreate && !isEditing && !isInternal && (
              <>
                <Button size="sm" variant="outline" onClick={onPrint}>
                  <Printer className="mr-1.5 size-3.5" />
                  {t("common.print", "Print")}
                </Button>
                <Button size="sm" variant="outline" onClick={onEdit}>
                  <Pencil className="mr-1.5 size-3.5" />
                  {t("common.edit", "Edit")}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="ghost" className="size-8 p-0">
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={onDuplicate}>
                      <Copy className="mr-2 size-3.5" />
                      {t("common.duplicate", "Duplicate")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={onDeleteOpen}
                    >
                      <Trash2 className="mr-2 size-3.5" />
                      {t("common.delete", "Delete")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
            {isEditing && (
              <>
                {aiEnabled && (
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    disabled={saving || aiLoading}
                    onClick={onAiFill}
                    className="text-blue-600 border-blue-200 hover:bg-blue-50 dark:text-blue-400 dark:border-blue-800 dark:hover:bg-blue-950/50"
                  >
                    {aiLoading ? (
                      <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="mr-1.5 size-3.5" />
                    )}
                    {t("ai.fill", "AI Fill")}
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
                  {t("common.cancel", "Cancel")}
                </Button>
                <Button size="sm" type="submit" form="auto-form" disabled={saving}>
                  {saving && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
                  {t("common.save", "Save")}
                </Button>
              </>
            )}
          </div>
        </TooltipProvider>
      </div>
    </div>
  );
}
