/**
 * Surface tests for CalendarBoard.
 *
 * Bun's default runner has no DOM, so we don't render React end-to-end
 * (mirrors the cap-search-ui convention). Instead we verify the
 * exported surface and prop contract holds — the wire contract that
 * downstream consumers depend on.
 */

import { describe, expect, it } from "bun:test";

const surface = await import("../src/index");
const { capViewCalendar } = surface;

describe("cap-view-calendar capability", () => {
  it("declares the expected metadata", () => {
    expect(capViewCalendar.name).toBe("cap-view-calendar");
    expect(capViewCalendar.type).toBe("standard");
    expect(capViewCalendar.category).toBe("view");
    expect(capViewCalendar.version).toBe("0.1.0");
    expect(capViewCalendar.autoInstall).toBe(false);
  });

  it("depends on cap-adapter-ui", () => {
    expect(capViewCalendar.dependencies).toEqual(["cap-adapter-ui"]);
  });
});

describe("cap-view-calendar exports", () => {
  it("exposes the rendering surface", () => {
    expect(typeof surface.CalendarBoard).toBe("function");
    expect(typeof surface.CalendarGrid).toBe("function");
    expect(typeof surface.CalendarEvent).toBe("function");
  });

  it("exposes the pure-logic helpers", () => {
    expect(typeof surface.parseCalendarDate).toBe("function");
    expect(typeof surface.toDayKey).toBe("function");
    expect(typeof surface.getCalendarRange).toBe("function");
    expect(typeof surface.toEventChips).toBe("function");
    expect(typeof surface.bucketChipsIntoCells).toBe("function");
    expect(typeof surface.useCalendarData).toBe("function");
  });
});

describe("CalendarBoard prop contract", () => {
  it("accepts the documented prop shape without runtime errors", () => {
    // Compile-time check via type — assigning a valid prop bag must succeed.
    const props: import("../src/types").CalendarBoardProps = {
      entity: "task",
      dateField: "due_date",
      titleField: "title",
      data: [
        { id: 1, due_date: "2026-05-16", title: "Review" },
        { id: 2, due_date: "2026-05-17", end_date: "2026-05-19", title: "Workshop" },
      ],
      endDateField: "end_date",
      initialMode: "month",
      onEventClick: () => {
        /* noop */
      },
      onMoveEvent: () => {
        /* noop */
      },
    };
    expect(props.entity).toBe("task");
    expect(props.data.length).toBe(2);
  });

  it("treats all view-mode discriminants as assignable", () => {
    const modes: import("../src/types").CalendarViewMode[] = ["month", "week", "day"];
    expect(modes.length).toBe(3);
  });
});
