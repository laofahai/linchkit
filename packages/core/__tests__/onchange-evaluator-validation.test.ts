/**
 * Onchange evaluator — structured validation errors (Spec 64 §4.1).
 *
 * Verifies that the evaluator throws `OnchangeEvaluatorError` with the correct
 * discriminator `code` for each input-shape failure so the REST layer can map
 * it to the right HTTP status.
 */

import { describe, expect, test } from "bun:test";
import { createOnchangeEvaluator, OnchangeEvaluatorError } from "../src/engine/onchange-evaluator";
import { createEntityRegistry } from "../src/entity/entity-registry";
import type { EntityDefinition } from "../src/types/entity";
import { ACTOR, createStubDataProvider, registerEntity } from "./onchange-evaluator-fixtures";

describe("createOnchangeEvaluator — validation errors", () => {
  test("throws ENTITY_NOT_FOUND when entity is unknown", async () => {
    const evaluator = createOnchangeEvaluator({
      entityRegistry: createEntityRegistry(),
      dataProvider: createStubDataProvider(),
    });
    try {
      await evaluator.evaluate({
        entityName: "ghost",
        changedField: "x",
        values: {},
        actor: ACTOR,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OnchangeEvaluatorError);
      expect((err as OnchangeEvaluatorError).code).toBe("ENTITY_NOT_FOUND");
    }
  });

  test("throws ENTITY_HAS_NO_ONCHANGE when entity has no onchange map", async () => {
    const entity: EntityDefinition = {
      name: "plain",
      fields: { x: { type: "string" } },
    };
    const evaluator = createOnchangeEvaluator({
      entityRegistry: registerEntity(entity),
      dataProvider: createStubDataProvider(),
    });
    try {
      await evaluator.evaluate({
        entityName: "plain",
        changedField: "x",
        values: { x: "v" },
        actor: ACTOR,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OnchangeEvaluatorError);
      expect((err as OnchangeEvaluatorError).code).toBe("ENTITY_HAS_NO_ONCHANGE");
    }
  });

  test("throws FIELD_UNKNOWN when changedField is not on the entity", async () => {
    const entity: EntityDefinition = {
      name: "line",
      fields: { a: { type: "string" } },
      onchange: {
        a: { updates: [], compute: () => ({}) },
      },
    };
    const evaluator = createOnchangeEvaluator({
      entityRegistry: registerEntity(entity),
      dataProvider: createStubDataProvider(),
    });
    try {
      await evaluator.evaluate({
        entityName: "line",
        changedField: "nope",
        values: {},
        actor: ACTOR,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OnchangeEvaluatorError);
      expect((err as OnchangeEvaluatorError).code).toBe("FIELD_UNKNOWN");
    }
  });

  test("throws NO_HOOK_FOR_FIELD when field exists on entity but has no onchange hook", async () => {
    // Entity has an onchange map covering `a`, but the caller triggers on `b`.
    // Spec 64 §4.1 says this is a 404 case — the evaluator must surface it as
    // a distinct, typed error so the REST layer maps it to the right status.
    const entity: EntityDefinition = {
      name: "line",
      fields: {
        a: { type: "string" },
        b: { type: "string" },
      },
      onchange: {
        a: { updates: [], compute: () => ({}) },
      },
    };
    const evaluator = createOnchangeEvaluator({
      entityRegistry: registerEntity(entity),
      dataProvider: createStubDataProvider(),
    });
    try {
      await evaluator.evaluate({
        entityName: "line",
        changedField: "b",
        values: { b: "v" },
        actor: ACTOR,
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(OnchangeEvaluatorError);
      expect((err as OnchangeEvaluatorError).code).toBe("NO_HOOK_FOR_FIELD");
    }
  });
});
