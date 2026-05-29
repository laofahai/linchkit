/**
 * TimelineBoard surface + controlled-component contract tests.
 *
 * The repo's existing UI test setup runs without a DOM (see
 * addons/view-kanban/cap-view-kanban/__tests__/KanbanBoard.test.tsx for the
 * precedent — render-level tests are deferred until the repo gains a
 * happy-dom / jsdom harness). These tests therefore cover:
 *
 *  1. Public exports surface — TimelineBoard is a real React component and
 *     capability metadata is consistent.
 *  2. Controlled-component contract — the source declares `anchor` as a
 *     derivation of the `currentDate` prop (controlled mode), not as
 *     `useState(currentDate)` (which would only seed once at mount and
 *     ignore prop updates). This is a source-shape assertion guarding the
 *     fix for Gemini review comment #1 on PR #340.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { TimelineBoard, capViewTimeline } = await import("../src/index");

const TIMELINE_BOARD_SOURCE = readFileSync(
  join(import.meta.dir, "..", "src", "TimelineBoard.tsx"),
  "utf8",
);

describe("cap-view-timeline exports", () => {
  test("exposes TimelineBoard as a React component (function)", () => {
    expect(typeof TimelineBoard).toBe("function");
  });
});

describe("capViewTimeline metadata", () => {
  test("declares the expected name, type, and category", () => {
    expect(capViewTimeline.name).toBe("cap-view-timeline");
    expect(capViewTimeline.type).toBe("standard");
    expect(capViewTimeline.category).toBe("view");
  });
});

describe("TimelineBoard controlled-component contract", () => {
  test("does NOT seed anchor solely via useState(currentDate) — that would ignore prop updates after mount", () => {
    // The buggy pattern was `useState<Date>(currentDate ?? new Date())` with
    // no sync effect, so a parent changing currentDate after mount could not
    // move the visible window. Reject that exact shape.
    expect(TIMELINE_BOARD_SOURCE).not.toMatch(/useState<Date>\(\s*currentDate\b/);
    // Also reject the lazy-initialiser variant of the same bug.
    expect(TIMELINE_BOARD_SOURCE).not.toMatch(
      /useState<Date>\(\s*\(\s*\)\s*=>\s*startOfDay\(currentDate\)\s*\)/,
    );
  });

  test("derives anchor from the currentDate prop when provided (controlled mode)", () => {
    // The fix derives anchor on every render: prop wins when supplied,
    // internal state is the fallback for the uncontrolled case.
    expect(TIMELINE_BOARD_SOURCE).toMatch(
      /const\s+anchor\s*=\s*currentDate\s*\?\s*startOfDay\(currentDate\)\s*:\s*anchorState/,
    );
  });

  test("keeps an internal anchorState for the uncontrolled case", () => {
    expect(TIMELINE_BOARD_SOURCE).toMatch(/setAnchorState\s*\(/);
    expect(TIMELINE_BOARD_SOURCE).toMatch(
      /useState<Date>\(\s*\(\s*\)\s*=>\s*startOfDay\(currentDate\s*\?\?\s*new Date\(\)\)\s*\)/,
    );
  });
});

describe("TimelineBoard render-loop performance", () => {
  test("uses the map callback index for column grid lines, not columns.indexOf(col)", () => {
    // O(N) per render instead of O(N²). Guards the fix for Gemini comment #2.
    expect(TIMELINE_BOARD_SOURCE).not.toMatch(/columns\.indexOf\(col\)/);
    expect(TIMELINE_BOARD_SOURCE).toMatch(/columns\.map\(\(col,\s*idx\)\s*=>/);
  });
});
