/**
 * cap-chatter-ui capability shape tests.
 *
 * Importing the package entry also runs its side-effect `registerRecordPanel`
 * call, so we additionally assert the record-detail panel it should register.
 */

import { describe, expect, it } from "bun:test";
import { getRecordPanels } from "@linchkit/cap-adapter-ui/panel-registry";
import { capChatterUi } from "../src";

describe("capChatterUi", () => {
  it("declares the expected identity fields", () => {
    expect(capChatterUi.name).toBe("cap-chatter-ui");
    expect(capChatterUi.type).toBe("standard");
    expect(capChatterUi.category).toBe("system");
    expect(capChatterUi.version).toBe("0.1.0");
  });

  it("depends on the UI shell and the chatter capability", () => {
    expect(capChatterUi.dependencies).toEqual(
      expect.arrayContaining(["cap-adapter-ui", "cap-chatter"]),
    );
  });

  it("registers the chatter record-detail panel on import", () => {
    const panel = getRecordPanels().find((p) => p.id === "chatter");
    expect(panel).toBeDefined();
    expect(panel?.slot).toBe("record-detail-tab");
    expect(panel?.capability).toBe("cap-chatter");
  });
});
