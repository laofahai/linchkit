/**
 * Schema form page — loading, error, and empty state UI components.
 */

import { Button, Skeleton } from "@linchkit/ui-kit/components";
import { ArrowLeft, RefreshCw, ServerCrash } from "lucide-react";
import type { TFunction } from "i18next";

export interface MissingSchemaStateProps {
  t: TFunction;
}

/** Shown when no schema name is present in the route. */
export function MissingSchemaState({ t }: MissingSchemaStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-64 gap-3 text-muted-foreground">
      <ServerCrash className="size-10" />
      <p className="text-sm">
        {t("errors.missingSchemaName", "No schema specified in the URL.")}
      </p>
    </div>
  );
}

/** Full-page loading skeleton matching the form layout. */
export function FormLoadingSkeleton() {
  return (
    <div className="bg-muted/30 min-h-full">
      {/* Sticky control panel skeleton */}
      <div className="sticky top-0 z-10 bg-background border-b px-4 py-2">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-8 rounded" />
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-16" />
            <Skeleton className="h-8 w-16" />
          </div>
        </div>
      </div>
      {/* Sheet card skeleton */}
      <div className="flex gap-6 my-4 px-4">
        <div className="flex-1 min-w-0 space-y-4">
          <div className="bg-background rounded shadow-sm border border-border/50 px-6 py-4 space-y-6">
            {/* Title + status bar */}
            <div className="flex items-center justify-between">
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-5 w-64" />
            </div>
            {/* Form field rows */}
            {Array.from({ length: 5 }, (_, i) => `skel-field-${i}`).map((key) => (
              <div key={key} className="space-y-2">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-9 w-full" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export interface BundleErrorStateProps {
  t: TFunction;
  schemaName: string;
  onRetry: () => void;
}

/** Shown when the schema bundle fails to load. */
export function BundleErrorState({ t, schemaName, onRetry }: BundleErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-64 gap-3 text-muted-foreground">
      <ServerCrash className="size-10" />
      <p className="text-sm font-medium">
        {t("errors.schemaLoadFailed", 'Failed to load schema "{{name}}".', { name: schemaName })}
      </p>
      <p className="text-xs">
        {t(
          "errors.checkServer",
          "Check that the server is running and the schema is registered.",
        )}
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw className="mr-1.5 size-3.5" />
        {t("common.retry", "Retry")}
      </Button>
    </div>
  );
}

export interface RecordErrorStateProps {
  t: TFunction;
  error: string;
  onBack: () => void;
  onRetry: () => void;
}

/** Shown when a specific record fails to load (view/edit mode). */
export function RecordErrorState({ t, error, onBack, onRetry }: RecordErrorStateProps) {
  return (
    <div className="bg-muted/30 min-h-full">
      <div className="sticky top-0 z-10 bg-background border-b px-4 py-2">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft className="size-4" />
        </Button>
      </div>
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-muted-foreground">
        <ServerCrash className="size-10" />
        <p className="text-sm font-medium">
          {t("errors.recordLoadFailed", "Failed to load record.")}
        </p>
        <p className="text-xs text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="mr-1.5 size-3.5" />
          {t("common.retry", "Retry")}
        </Button>
      </div>
    </div>
  );
}
