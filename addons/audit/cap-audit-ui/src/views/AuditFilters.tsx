/**
 * AuditFilters — filter toolbar for the audit log list.
 *
 * Stateless / controlled — the parent owns the `AuditFilters` value
 * and decides when to actually re-fetch. This keeps the list page in
 * full control of debounce / submit semantics.
 */

import { Button, Input, Label } from "@linchkit/ui-kit/components";
import { RotateCcw, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  AUDIT_STATUSES,
  type AuditFilters as AuditFiltersValue,
  type AuditStatus,
} from "../lib/audit-api";

export interface AuditFiltersProps {
  value: AuditFiltersValue;
  onChange: (next: AuditFiltersValue) => void;
  onApply: () => void;
  onReset: () => void;
}

export function AuditFiltersBar(props: AuditFiltersProps) {
  const { value, onChange, onApply, onReset } = props;
  const { t } = useTranslation();

  function patch(next: Partial<AuditFiltersValue>) {
    onChange({ ...value, ...next });
  }

  return (
    <form
      className="flex flex-wrap items-end gap-3 rounded-md border bg-muted/20 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        onApply();
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="audit-filter-action" className="text-xs">
          {t("audit.filters.action", "Action")}
        </Label>
        <Input
          id="audit-filter-action"
          value={value.action ?? ""}
          onChange={(e) => patch({ action: e.target.value || undefined })}
          placeholder="create_order"
          className="h-8 w-44"
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="audit-filter-actor" className="text-xs">
          {t("audit.filters.actor", "Actor")}
        </Label>
        <Input
          id="audit-filter-actor"
          value={value.actorId ?? ""}
          onChange={(e) => patch({ actorId: e.target.value || undefined })}
          placeholder="user-id"
          className="h-8 w-40"
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="audit-filter-entity" className="text-xs">
          {t("audit.filters.entity", "Entity")}
        </Label>
        <Input
          id="audit-filter-entity"
          value={value.entity ?? ""}
          onChange={(e) => patch({ entity: e.target.value || undefined })}
          placeholder="order"
          className="h-8 w-40"
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="audit-filter-status" className="text-xs">
          {t("audit.filters.status", "Status")}
        </Label>
        <select
          id="audit-filter-status"
          value={value.status ?? ""}
          onChange={(e) =>
            patch({ status: (e.target.value || undefined) as AuditStatus | undefined })
          }
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="">{t("audit.filters.statusAny", "Any")}</option>
          {AUDIT_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </div>

      {/*
        Date range filters (After / Before) are intentionally hidden until
        SystemDataProvider supports range operators. Showing them while
        buildAuditFilter drops the values produced an "Apply" that looked
        successful but didn't change the wire payload — confusing UX. The
        AuditFilters type retains the fields so the prop shape doesn't break
        when range support lands and the inputs return.
      */}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm">
          <Search className="mr-1 size-3.5" />
          {t("audit.filters.apply", "Apply")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onReset}
          aria-label={t("audit.filters.reset", "Reset filters")}
        >
          <RotateCcw className="size-3.5" />
        </Button>
      </div>
    </form>
  );
}

export default AuditFiltersBar;
