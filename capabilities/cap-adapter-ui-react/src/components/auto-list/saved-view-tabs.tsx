/**
 * SavedViewTabs — Horizontal tab strip for saved views above AutoList.
 *
 * Shows an "All" tab (default), followed by user-created saved views.
 * Includes a "+" button to save the current filter state as a new view,
 * and right-click / dropdown actions to rename or delete a view.
 */

import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@linchkit/ui-kit/components";
import { cn } from "@linchkit/ui-kit/lib/utils";
import { MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SavedView } from "../../hooks/use-saved-views";

export interface SavedViewTabsProps {
  views: SavedView[];
  activeViewId: string | null;
  onSelectView: (viewId: string | null) => void;
  onCreateView: (name: string) => void;
  onRenameView: (viewId: string, newName: string) => void;
  onDeleteView: (viewId: string) => void;
  /** Whether filters are currently active (enables save button). */
  hasActiveFilters: boolean;
}

export function SavedViewTabs({
  views,
  activeViewId,
  onSelectView,
  onCreateView,
  onRenameView,
  onDeleteView,
  hasActiveFilters,
}: SavedViewTabsProps) {
  const { t } = useTranslation();
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renamingView, setRenamingView] = useState<SavedView | null>(null);
  const [viewName, setViewName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSave = useCallback(() => {
    const name = viewName.trim();
    if (!name) return;
    onCreateView(name);
    setViewName("");
    setSaveDialogOpen(false);
  }, [viewName, onCreateView]);

  const handleRename = useCallback(() => {
    const name = viewName.trim();
    if (!name || !renamingView) return;
    onRenameView(renamingView.id, name);
    setViewName("");
    setRenamingView(null);
    setRenameDialogOpen(false);
  }, [viewName, renamingView, onRenameView]);

  const openRenameDialog = useCallback((view: SavedView) => {
    setRenamingView(view);
    setViewName(view.name);
    setRenameDialogOpen(true);
  }, []);

  return (
    <>
      <div className="flex items-center gap-1 border-b border-border pb-0 overflow-x-auto">
        {/* "All" default tab */}
        <button
          type="button"
          className={cn(
            "shrink-0 px-3 py-1.5 text-sm font-medium border-b-2 transition-colors",
            activeViewId === null
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30",
          )}
          onClick={() => onSelectView(null)}
        >
          {t("list.allStates", "All")}
        </button>

        {/* Saved view tabs */}
        {views.map((view) => (
          <div key={view.id} className="group relative flex items-center shrink-0">
            <button
              type="button"
              className={cn(
                "px-3 py-1.5 text-sm font-medium border-b-2 transition-colors",
                activeViewId === view.id
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30",
              )}
              onClick={() => onSelectView(view.id)}
            >
              {view.name}
            </button>

            {/* Dropdown for rename / delete */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                >
                  <MoreHorizontal className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-36">
                <DropdownMenuItem onClick={() => openRenameDialog(view)}>
                  <Pencil className="mr-2 size-3.5" />
                  {t("viewTabs.rename", "Rename")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => onDeleteView(view.id)}
                >
                  <Trash2 className="mr-2 size-3.5" />
                  {t("common.delete", "Delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}

        {/* Save current view button — no `disabled` attr so Tooltip works on hover */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-disabled={!hasActiveFilters}
              className={cn(
                "shrink-0 flex items-center gap-1 px-2 py-1.5 text-sm border-b-2 border-transparent transition-colors",
                hasActiveFilters
                  ? "text-muted-foreground hover:text-foreground"
                  : "text-muted-foreground/40 cursor-not-allowed opacity-50",
              )}
              onClick={() => {
                if (hasActiveFilters) {
                  setViewName("");
                  setSaveDialogOpen(true);
                }
              }}
            >
              <Plus className="size-3.5" />
              <span className="hidden sm:inline">{t("viewTabs.newView", "New View")}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>
              {hasActiveFilters
                ? t("viewTabs.saveView", "Save current filters as view")
                : t("viewTabs.noFilters", "Apply filters first to save a view")}
            </p>
          </TooltipContent>
        </Tooltip>
      </div>

      {/* Save dialog */}
      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("viewTabs.saveViewTitle", "Save View")}</DialogTitle>
            <DialogDescription>
              {t(
                "viewTabs.saveViewDesc",
                "Save the current filters as a named view for quick access.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Input
              ref={inputRef}
              value={viewName}
              onChange={(e) => setViewName(e.target.value)}
              placeholder={t("viewTabs.viewNamePlaceholder", "e.g. My Pending Items")}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSave();
              }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" size="sm">
                {t("common.cancel", "Cancel")}
              </Button>
            </DialogClose>
            <Button size="sm" disabled={!viewName.trim()} onClick={handleSave}>
              {t("common.save", "Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename dialog */}
      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("viewTabs.renameTitle", "Rename View")}</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Input
              value={viewName}
              onChange={(e) => setViewName(e.target.value)}
              placeholder={t("viewTabs.viewNamePlaceholder", "e.g. My Pending Items")}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRename();
              }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" size="sm">
                {t("common.cancel", "Cancel")}
              </Button>
            </DialogClose>
            <Button size="sm" disabled={!viewName.trim()} onClick={handleRename}>
              {t("common.save", "Save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
