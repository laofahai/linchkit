/**
 * EventsPage — top-level admin route combining the timeline, the
 * handler side panel, and the replay dialog.
 *
 * State distribution:
 *   - `expandedEventId` is the event whose handler panel is open.
 *   - `replayTarget` is the event pinned in the replay dialog (kept
 *     separate so the user can have a row expanded while opening the
 *     replay dialog from a different row).
 *
 * Refresh after a successful replay is left to the user — replay never
 * mutates the original event row, so the list does not need to refetch.
 */

import { useState } from "react";
import type { EventSummary } from "../lib/eventsClient";
import EventHandlersPanel from "../views/EventHandlersPanel";
import EventReplayDialog from "../views/EventReplayDialog";
import EventTimeline from "../views/EventTimeline";

export default function EventsPage() {
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [replayTarget, setReplayTarget] = useState<EventSummary | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  function handleReplay(event: EventSummary) {
    setReplayTarget(event);
    setDialogOpen(true);
  }

  function handleDialogOpenChange(open: boolean) {
    setDialogOpen(open);
    // Drop the pinned event once the dialog has finished closing so the
    // next open starts from a clean slate; the dialog itself resets its
    // form state on open.
    if (!open) {
      setReplayTarget(null);
    }
  }

  return (
    <div className="flex h-full">
      <div className="flex-1 overflow-auto">
        <EventTimeline
          expandedEventId={expandedEventId}
          onToggleHandlers={setExpandedEventId}
          onReplay={handleReplay}
        />
      </div>

      {expandedEventId && (
        <EventHandlersPanel eventId={expandedEventId} onClose={() => setExpandedEventId(null)} />
      )}

      <EventReplayDialog
        open={dialogOpen}
        eventId={replayTarget?.id ?? null}
        eventLabel={replayTarget?.eventType ?? undefined}
        onOpenChange={handleDialogOpenChange}
      />
    </div>
  );
}
