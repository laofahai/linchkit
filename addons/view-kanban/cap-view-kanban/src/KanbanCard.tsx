/**
 * KanbanCard — single record card rendered inside a KanbanColumn.
 *
 * Uses @dnd-kit's `useDraggable` so the card is keyboard- and pointer-
 * accessible by default (Space to lift, arrow keys to move, Enter to drop).
 * Clicking a card (without dragging) calls `onClick` with the record id.
 */

import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import type { CSSProperties, JSX, KeyboardEvent, MouseEvent } from "react";
import type { KanbanCardProps, KanbanRecord } from "./types";

/** Stringify an arbitrary field value for card display. */
function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return `${value.length} items`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("name" in obj) return String(obj.name);
    if ("label" in obj) return String(obj.label);
    if ("id" in obj) return String(obj.id);
    return JSON.stringify(value);
  }
  return String(value);
}

/** Pick the field used as the card title — explicit override > presentation hint > first field > id. */
function resolveTitleField(
  schema: KanbanCardProps["schema"],
  cardFields: ReadonlyArray<string>,
): string {
  if (cardFields.length > 0) return cardFields[0] ?? "id";
  const presentationTitle = schema.presentation?.titleField;
  if (presentationTitle) return presentationTitle;
  const firstField = Object.keys(schema.fields)[0];
  return firstField ?? "id";
}

export function KanbanCard({
  record,
  schema,
  cardFields,
  onClick,
  isPending,
}: KanbanCardProps): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: record.id,
    data: { recordId: record.id },
    disabled: isPending,
  });

  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging || isPending ? 0.5 : 1,
    cursor: isPending ? "wait" : "grab",
  };

  const titleField = resolveTitleField(schema, cardFields);
  const secondaryFields = cardFields.slice(1);
  const titleValue = displayValue(record[titleField]) || record.id;

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    // Suppress click that came from a drag end.
    if (isDragging) return;
    event.stopPropagation();
    onClick?.(record.id);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Allow Enter / Space to activate the card when it isn't being dragged.
    // dnd-kit's sensors handle activation under its own modifier keys.
    if (event.key === "Enter" && !event.defaultPrevented) {
      onClick?.(record.id);
    }
  };

  return (
    // dnd-kit's `attributes` spread provides role="button", tabIndex, aria-roledescription,
    // aria-disabled, aria-pressed at runtime. Biome's static a11y rules can't see across the
    // spread, so the two suppressions below are intentional — the element IS interactive and
    // role-compatible with aria-label, just not visibly so to the static analyzer.
    // biome-ignore lint/a11y/noStaticElementInteractions: dnd-kit injects role="button" via {...attributes}
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: dnd-kit injects role="button" via {...attributes}, which supports aria-label
    <div
      ref={setNodeRef}
      aria-label={`Card ${titleValue}`}
      data-card-id={record.id}
      data-pending={isPending ? "true" : "false"}
      style={style}
      className="rounded-md border border-border bg-card p-3 text-sm shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      {...attributes}
      {...listeners}
    >
      <div className="truncate font-medium text-foreground">{titleValue}</div>
      {secondaryFields.length > 0 ? (
        <dl className="mt-1.5 space-y-0.5">
          {secondaryFields.map((field) => {
            const value = record[field as keyof KanbanRecord];
            if (value === null || value === undefined || value === "") return null;
            const fieldDef = schema.fields[field];
            const label = fieldDef?.label ?? field;
            return (
              <div key={field} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <dt className="shrink-0">{label}:</dt>
                <dd className="truncate text-foreground/80">{displayValue(value)}</dd>
              </div>
            );
          })}
        </dl>
      ) : null}
    </div>
  );
}
