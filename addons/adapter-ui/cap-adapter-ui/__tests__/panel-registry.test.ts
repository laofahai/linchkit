import { describe, expect, test, beforeEach } from "bun:test";
import {
  registerRecordPanel,
  getRecordPanels,
  clearRecordPanels,
} from "../src/lib/panel-registry";

beforeEach(() => {
  clearRecordPanels();
});

describe("panel-registry", () => {
  test("registers and retrieves a panel", () => {
    registerRecordPanel({
      id: "chatter",
      capability: "cap-chatter",
      slot: "record-detail-tab",
      label: "Chatter",
      order: 100,
      component: () => Promise.resolve({ default: (() => null) as React.FC }),
    });
    const panels = getRecordPanels();
    expect(panels).toHaveLength(1);
    expect(panels[0]?.id).toBe("chatter");
  });

  test("sorts by order", () => {
    registerRecordPanel({
      id: "b",
      capability: "cap-b",
      slot: "record-detail-tab",
      label: "B",
      order: 200,
      component: () => Promise.resolve({ default: (() => null) as React.FC }),
    });
    registerRecordPanel({
      id: "a",
      capability: "cap-a",
      slot: "record-detail-tab",
      label: "A",
      order: 50,
      component: () => Promise.resolve({ default: (() => null) as React.FC }),
    });
    const panels = getRecordPanels();
    expect(panels[0]?.id).toBe("a");
    expect(panels[1]?.id).toBe("b");
  });

  test("default order is 100", () => {
    registerRecordPanel({
      id: "no-order",
      capability: "cap-x",
      slot: "record-detail-tab",
      label: "X",
      component: () => Promise.resolve({ default: (() => null) as React.FC }),
    });
    registerRecordPanel({
      id: "high-order",
      capability: "cap-y",
      slot: "record-detail-tab",
      label: "Y",
      order: 200,
      component: () => Promise.resolve({ default: (() => null) as React.FC }),
    });
    const panels = getRecordPanels();
    expect(panels[0]?.id).toBe("no-order");
    expect(panels[1]?.id).toBe("high-order");
  });

  test("rejects duplicate id", () => {
    registerRecordPanel({
      id: "dup",
      capability: "cap-x",
      slot: "record-detail-tab",
      label: "X",
      component: () => Promise.resolve({ default: (() => null) as React.FC }),
    });
    expect(() =>
      registerRecordPanel({
        id: "dup",
        capability: "cap-y",
        slot: "record-detail-tab",
        label: "Y",
        component: () => Promise.resolve({ default: (() => null) as React.FC }),
      }),
    ).toThrow(/already registered/);
  });
});
