import { describe, expect, it } from "bun:test";
import { createScenarioRegistry } from "../../src/ai-eval";
import { makeMockIntentScenario } from "./helpers";

describe("createScenarioRegistry", () => {
  it("registers and retrieves scenario adapters by name", () => {
    const registry = createScenarioRegistry();
    const adapter = makeMockIntentScenario();
    registry.register("intent", adapter);
    expect(registry.list()).toEqual(["intent"]);
    expect(registry.get("intent")).toBeDefined();
    expect(registry.get("unknown")).toBeUndefined();
  });

  it("throws when re-registering the same name", () => {
    const registry = createScenarioRegistry();
    registry.register("intent", makeMockIntentScenario());
    expect(() => registry.register("intent", makeMockIntentScenario())).toThrow(
      /already registered/,
    );
  });
});
