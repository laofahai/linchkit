import { describe, expect, test } from "bun:test";
import type { ActionDefinition } from "@linchkit/core";
import { actionToSkill, generateAgentCard, isA2aExposed } from "../src/agent-card";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeAction(overrides: Partial<ActionDefinition> = {}): ActionDefinition {
  return {
    name: "create_order",
    entity: "order",
    label: "Create Order",
    description: "Creates a new order",
    policy: { requireAuth: true },
    ...overrides,
  } as ActionDefinition;
}

// ── isA2aExposed ─────────────────────────────────────────────────────────────

describe("isA2aExposed", () => {
  test("includes action with no exposure config", () => {
    expect(isA2aExposed(makeAction())).toBe(true);
  });

  test('includes action with exposure "all"', () => {
    expect(isA2aExposed(makeAction({ exposure: "all" }))).toBe(true);
  });

  test("includes action with exposure.a2a explicitly true", () => {
    expect(isA2aExposed(makeAction({ exposure: { a2a: true } }))).toBe(true);
  });

  test("includes action with exposure.http true (no a2a key)", () => {
    expect(isA2aExposed(makeAction({ exposure: { http: true } }))).toBe(true);
  });

  test("excludes action with exposure.a2a === false", () => {
    expect(isA2aExposed(makeAction({ exposure: { a2a: false } }))).toBe(false);
  });

  test("excludes action with exposure.internal === true", () => {
    expect(isA2aExposed(makeAction({ exposure: { internal: true } }))).toBe(false);
  });

  test("internal takes precedence over a2a:true", () => {
    expect(isA2aExposed(makeAction({ exposure: { internal: true, a2a: true } }))).toBe(false);
  });

  test("excludes unknown string exposure values (fail-closed)", () => {
    // Runtime bypass or dynamic config might pass unexpected strings — exclude them.
    expect(isA2aExposed(makeAction({ exposure: "public" as "all" }))).toBe(false);
    expect(isA2aExposed(makeAction({ exposure: "none" as "all" }))).toBe(false);
  });
});

// ── actionToSkill ─────────────────────────────────────────────────────────────

describe("actionToSkill", () => {
  test("maps name, label, description, and entity to skill fields", () => {
    const skill = actionToSkill(
      makeAction({ name: "submit_order", label: "Submit Order", description: "Submits an order" }),
    );

    expect(skill.id).toBe("submit_order");
    expect(skill.name).toBe("Submit Order");
    expect(skill.description).toBe("Submits an order");
    expect(skill.tags).toContain("order");
  });

  test("falls back to action.name when label is empty", () => {
    const skill = actionToSkill(makeAction({ label: "" }));
    expect(skill.name).toBe("create_order");
  });

  test("generates default description when action has none", () => {
    const skill = actionToSkill(makeAction({ description: undefined }));
    expect(skill.description).toContain("create_order");
  });

  test("sets json input/output modes", () => {
    const skill = actionToSkill(makeAction());
    expect(skill.inputModes).toEqual(["application/json"]);
    expect(skill.outputModes).toEqual(["application/json"]);
  });

  test("produces empty tags when entity is falsy to avoid [null] in JSON", () => {
    const skill = actionToSkill(makeAction({ entity: "" }));
    expect(skill.tags).toEqual([]);
  });
});

// ── generateAgentCard ─────────────────────────────────────────────────────────

describe("generateAgentCard", () => {
  const baseOptions = {
    name: "TestAgent",
    description: "A test agent",
    url: "https://agent.example.com",
    version: "1.2.3",
    actions: [makeAction()],
  };

  test("sets protocolVersion to 1.0", () => {
    const card = generateAgentCard(baseOptions);
    expect(card.protocolVersion).toBe("1.0");
  });

  test("copies name, description, url, version", () => {
    const card = generateAgentCard(baseOptions);
    expect(card.name).toBe("TestAgent");
    expect(card.description).toBe("A test agent");
    expect(card.url).toBe("https://agent.example.com");
    expect(card.version).toBe("1.2.3");
  });

  test("capabilities default to streaming=false, pushNotifications=false, stateTransitionHistory=false", () => {
    const card = generateAgentCard(baseOptions);
    expect(card.capabilities.streaming).toBe(false);
    expect(card.capabilities.pushNotifications).toBe(false);
    expect(card.capabilities.stateTransitionHistory).toBe(false);
  });

  test("defaultInputModes and defaultOutputModes contain application/json", () => {
    const card = generateAgentCard(baseOptions);
    expect(card.defaultInputModes).toContain("application/json");
    expect(card.defaultOutputModes).toContain("application/json");
  });

  test("maps exposed actions to skills", () => {
    const card = generateAgentCard(baseOptions);
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0]?.id).toBe("create_order");
  });

  test("omits internal actions from skills", () => {
    const card = generateAgentCard({
      ...baseOptions,
      actions: [
        makeAction({ name: "visible_action" }),
        makeAction({ name: "hidden_action", exposure: { internal: true } }),
        makeAction({ name: "a2a_off_action", exposure: { a2a: false } }),
      ],
    });
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0]?.id).toBe("visible_action");
  });

  test("produces zero skills when all actions are internal", () => {
    const card = generateAgentCard({
      ...baseOptions,
      actions: [makeAction({ exposure: { internal: true } })],
    });
    expect(card.skills).toHaveLength(0);
  });

  test("produces zero skills from empty action list", () => {
    const card = generateAgentCard({ ...baseOptions, actions: [] });
    expect(card.skills).toHaveLength(0);
  });

  test("includes documentationUrl when provided", () => {
    const card = generateAgentCard({
      ...baseOptions,
      documentationUrl: "https://docs.example.com",
    });
    expect(card.documentationUrl).toBe("https://docs.example.com");
  });

  test("omits documentationUrl when not provided", () => {
    const card = generateAgentCard(baseOptions);
    expect(card.documentationUrl).toBeUndefined();
  });

  test("includes provider when providerOrg is given", () => {
    const card = generateAgentCard({ ...baseOptions, providerOrg: "Acme Corp" });
    expect(card.provider?.organization).toBe("Acme Corp");
  });

  test("omits provider when providerOrg is not given", () => {
    const card = generateAgentCard(baseOptions);
    expect(card.provider).toBeUndefined();
  });

  test("maps multiple actions to skills in order", () => {
    const card = generateAgentCard({
      ...baseOptions,
      actions: [
        makeAction({ name: "action_a", entity: "invoice" }),
        makeAction({ name: "action_b", entity: "payment" }),
      ],
    });
    expect(card.skills).toHaveLength(2);
    expect(card.skills[0]?.id).toBe("action_a");
    expect(card.skills[1]?.id).toBe("action_b");
  });

  test("skill tags include the action entity", () => {
    const card = generateAgentCard({
      ...baseOptions,
      actions: [makeAction({ name: "approve_invoice", entity: "invoice" })],
    });
    expect(card.skills[0]?.tags).toContain("invoice");
  });
});
