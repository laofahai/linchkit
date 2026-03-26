/**
 * EmptyState — Displayed when a schema list has no records.
 *
 * Shows an icon, title, description, and a CTA button to create
 * the first record. All text is localized via react-i18next.
 */

import { Button } from "@linchkit/ui-kit/components";
import { useNavigate } from "@tanstack/react-router";
import { PackageOpen, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface EmptyStateProps {
  /** Schema machine name (used for navigation). */
  schemaName: string;
  /** Human-readable schema label. */
  schemaLabel: string;
}

export function EmptyState({ schemaName, schemaLabel }: EmptyStateProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="flex flex-col items-center justify-center py-24 px-4 text-center">
      <div className="rounded-full bg-muted p-4 mb-4">
        <PackageOpen className="size-10 text-muted-foreground" />
      </div>

      <h3 className="text-lg font-medium text-foreground mb-1">
        {t("emptyState.title", "No {{label}} yet", { label: schemaLabel })}
      </h3>

      <p className="text-sm text-muted-foreground mb-6 max-w-sm">
        {t("emptyState.description", "Create your first {{label}} to get started.", {
          label: schemaLabel,
        })}
      </p>

      <Button
        onClick={() =>
          navigate({ to: "/schemas/$name/new", params: { name: schemaName } })
        }
      >
        <Plus className="mr-1.5 size-4" />
        {t("emptyState.createButton", "Create {{label}}", { label: schemaLabel })}
      </Button>
    </div>
  );
}
