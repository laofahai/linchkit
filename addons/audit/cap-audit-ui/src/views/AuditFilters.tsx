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

/**
 * Convert an `<input type="datetime-local">` value (no timezone) into
 * an ISO string. Returns `undefined` for empty input so we don't send
 * empty filter keys to the server.
 */
function toIso(local: string): string | undefined {
  if (!local) return undefined;
  const date = new Date(local);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

/**
 * Convert an ISO string back to the `datetime-local` input format
 * (YYYY-MM-DDTHH:mm). Empty / undefined → empty string.
 */
function fromIso(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  // Drop seconds and timezone — datetime-local accepts YYYY-MM-DDTHH:mm
  return date.toISOString().slice(0, 16);
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

      <div className="flex flex-col gap-1">
        <Label htmlFor="audit-filter-after" className="text-xs">
          {t("audit.filters.after", "After")}
        </Label>
        <Input
          id="audit-filter-after"
          type="datetime-local"
          value={fromIso(value.startedAfter)}
          onChange={(e) => patch({ startedAfter: toIso(e.target.value) })}
          className="h-8 w-52"
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="audit-filter-before" className="text-xs">
          {t("audit.filters.before", "Before")}
        </Label>
        <Input
          id="audit-filter-before"
          type="datetime-local"
          value={fromIso(value.startedBefore)}
          onChange={(e) => patch({ startedBefore: toIso(e.target.value) })}
          className="h-8 w-52"
        />
      </div>

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
