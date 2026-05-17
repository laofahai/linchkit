/**
 * CalendarEvent — single draggable event chip rendered inside a day cell.
 *
 * Wraps @dnd-kit's useDraggable so the host's onMoveEvent receives the
 * dropped target day. Stops click propagation so the surrounding day cell
 * doesn't also receive a click.
 */

import { useDraggable } from "@dnd-kit/core";
import type { CSSProperties } from "react";
import type { CalendarEventChip } from "./types";

export interface CalendarEventProps {
  chip: CalendarEventChip;
  /** When true, the chip is purely visual (no drag handle). */
  draggable?: boolean;
  /** Click handler — receives the source record. */
  onClick?: (chip: CalendarEventChip) => void;
}

export function CalendarEvent({ chip, draggable = true, onClick }: CalendarEventProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: chip.id,
    disabled: !draggable,
  });

  const style: CSSProperties = {
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    opacity: isDragging ? 0.5 : undefined,
  };

  return (
    <button
      type="button"
      ref={setNodeRef}
      style={style}
      data-testid="calendar-event"
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(chip);
      }}
      className="block w-full truncate rounded bg-primary/10 px-1 py-0.5 text-left text-[10px] leading-tight text-primary hover:bg-primary/20 focus:outline-none focus:ring-1 focus:ring-ring"
      title={chip.title}
      {...listeners}
      {...attributes}
    >
      {chip.title}
    </button>
  );
}
