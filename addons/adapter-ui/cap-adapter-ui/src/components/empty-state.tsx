/**
 * EmptyState — Displayed when a list has no records.
 *
 * Two modes:
 * 1. Schema-driven: pass `entityName` + `schemaLabel` for schema list pages (shows create button).
 * 2. Generic: pass `title` + optional `description` / `icon` / `hideAction` for admin pages.
 *
 * All text is localized via react-i18next.
 */

import { Button } from "@linchkit/ui-kit/components";
import { useNavigate } from "@tanstack/react-router";
import { PackageOpen, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface EmptyStateProps {
  /** Schema machine name (used for navigation). */
  entityName?: string;
  /** Human-readable schema label. */
  schemaLabel?: string;
  /** Override default title text. */
  title?: string;
  /** Override default description text. */
  description?: string;
  /** Override default icon. */
  icon?: React.ReactNode;
  /** Hide the create/action button (useful for admin pages where creation is not user-driven). */
  hideAction?: boolean;
}

export function EmptyState({
  entityName,
  schemaLabel,
  title,
  description,
  icon,
  hideAction = false,
}: EmptyStateProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const displayTitle =
    title ??
    (schemaLabel
      ? t("emptyState.title", "No {{label}} yet", { label: schemaLabel })
      : t("common.noData", "No data"));

  const displayDescription =
    description ??
    (schemaLabel
      ? hideAction
        ? t("emptyState.descriptionReadOnly", "No {{label}} records found.", { label: schemaLabel })
        : t("emptyState.description", "Create your first {{label}} to get started.", {
            label: schemaLabel,
          })
      : undefined);

  const showCreateButton = !hideAction && entityName && schemaLabel;

  return (
    <div className="flex flex-col items-center justify-center py-24 px-4 text-center">
      <div className="rounded-full bg-muted p-4 mb-4">
        {icon ?? <PackageOpen className="size-10 text-muted-foreground" />}
      </div>

      <h3 className="text-lg font-medium text-foreground mb-1">{displayTitle}</h3>

      {displayDescription && (
        <p className="text-sm text-muted-foreground mb-6 max-w-sm">{displayDescription}</p>
      )}

      {showCreateButton && (
        <Button
          onClick={() => navigate({ to: "/schemas/$name/new", params: { name: entityName } })}
        >
          <Plus className="mr-1.5 size-4" />
          {t("emptyState.createButton", "Create {{label}}", { label: schemaLabel })}
        </Button>
      )}
    </div>
  );
}
