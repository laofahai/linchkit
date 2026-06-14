/**
 * AG-UI HITL interrupt → ActionProposalCard adapter tests (Spec 71 §4.4).
 *
 * Pure logic-only (no jsdom): asserts the interrupt-metadata extraction,
 * Interrupt → IntentResolution mapping, the `data-lk-interrupt` chunk
 * detection, and the Approve/Cancel resume-answer construction (the payload
 * the Approve path produces, extracted to a pure helper per the P3 spec).
 */

import { describe, expect, test } from "bun:test";
import type { Interrupt as AgUiInterrupt } from "@ag-ui/client";
import { LK_INTERRUPT_DATA_CHUNK } from "../agui-chat-transport";
import {
  ACTION_APPROVAL_REASON,
  buildApproveAnswer,
  buildCancelAnswer,
  interruptToIntent,
  readActionApprovalMetadata,
  readInterruptChunk,
} from "../agui-interrupt";

function interrupt(overrides: Partial<AgUiInterrupt> = {}): AgUiInterrupt {
  return {
    id: "int_1",
    reason: ACTION_APPROVAL_REASON,
    toolCallId: "lk:propose-mutation:int_1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    metadata: {
      action: "create_product",
      proposedInput: { name: "Widget", price: 9.9 },
      inputSchema: { name: { type: "string", required: true } },
      actionLabel: "Create product",
      inputDigest: "digest_abc",
    },
    ...overrides,
  };
}

describe("readInterruptChunk", () => {
  test("returns the interrupts for the interrupt data chunk", () => {
    const part = { type: LK_INTERRUPT_DATA_CHUNK, data: { interrupts: [interrupt()] } };
    expect(readInterruptChunk(part)).toHaveLength(1);
  });

  test("returns null for any other data part", () => {
    expect(readInterruptChunk({ type: "data-something-else", data: {} })).toBeNull();
    expect(readInterruptChunk({ type: "data-text", data: undefined })).toBeNull();
  });

  test("returns null for a malformed interrupt chunk (no interrupts array)", () => {
    expect(readInterruptChunk({ type: LK_INTERRUPT_DATA_CHUNK, data: {} })).toBeNull();
    expect(
      readInterruptChunk({ type: LK_INTERRUPT_DATA_CHUNK, data: { interrupts: "x" } }),
    ).toBeNull();
  });
});

describe("readActionApprovalMetadata", () => {
  test("extracts a well-formed action-approval interrupt's metadata", () => {
    expect(readActionApprovalMetadata(interrupt())).toEqual({
      action: "create_product",
      proposedInput: { name: "Widget", price: 9.9 },
      inputSchema: { name: { type: "string", required: true } },
      actionLabel: "Create product",
      inputDigest: "digest_abc",
    });
  });

  test("rejects an interrupt with the wrong reason", () => {
    expect(readActionApprovalMetadata(interrupt({ reason: "something.else" }))).toBeNull();
  });

  test("rejects an interrupt missing action or inputDigest", () => {
    expect(
      readActionApprovalMetadata(interrupt({ metadata: { proposedInput: {}, inputDigest: "d" } })),
    ).toBeNull();
    expect(
      readActionApprovalMetadata(interrupt({ metadata: { action: "x", proposedInput: {} } })),
    ).toBeNull();
  });

  test("defaults actionLabel to action and proposedInput/inputSchema to empties", () => {
    const meta = readActionApprovalMetadata(
      interrupt({ metadata: { action: "do_thing", inputDigest: "d" } }),
    );
    expect(meta).toEqual({
      action: "do_thing",
      proposedInput: {},
      inputSchema: {},
      actionLabel: "do_thing",
      inputDigest: "d",
    });
  });

  test("carries alternatives + permitted hint when present", () => {
    const meta = readActionApprovalMetadata(
      interrupt({
        metadata: {
          action: "a",
          inputDigest: "d",
          alternatives: [
            { action: "b", input: {}, confidence: 0.6, missingFields: [], explanation: "" },
          ],
          permitted: false,
        },
      }),
    );
    expect(meta?.alternatives).toHaveLength(1);
    expect(meta?.permitted).toBe(false);
  });

  test("filters malformed inputSchema entries instead of blind-casting them", () => {
    const meta = readActionApprovalMetadata(
      interrupt({
        metadata: {
          action: "a",
          inputDigest: "d",
          inputSchema: {
            name: { type: "string", required: true }, // valid → kept
            broken: null, // invalid → dropped
            alsoBroken: { label: "no type field" }, // missing type/required → dropped
          },
        },
      }),
    );
    expect(Object.keys(meta?.inputSchema ?? {})).toEqual(["name"]);
  });

  test("filters malformed alternatives and drops the field when none survive", () => {
    const withMixed = readActionApprovalMetadata(
      interrupt({
        metadata: {
          action: "a",
          inputDigest: "d",
          alternatives: [
            { action: "b", input: {}, confidence: 0.5, missingFields: [], explanation: "" }, // valid
            null, // invalid
            { confidence: 0.9 }, // no action / no input → invalid
            { action: "c", input: "not-a-record" }, // bad input → invalid
          ],
        },
      }),
    );
    expect(withMixed?.alternatives).toHaveLength(1);
    expect(withMixed?.alternatives?.[0]?.action).toBe("b");

    const allBad = readActionApprovalMetadata(
      interrupt({ metadata: { action: "a", inputDigest: "d", alternatives: [null, 42, "x"] } }),
    );
    expect(allBad?.alternatives).toBeUndefined();
  });
});

describe("interruptToIntent", () => {
  test("maps metadata onto the ActionProposalCard's IntentResolution", () => {
    const meta = readActionApprovalMetadata(interrupt());
    if (!meta) throw new Error("expected metadata");
    const intent = interruptToIntent(meta);
    expect(intent.action).toBe("create_product");
    expect(intent.input).toEqual({ name: "Widget", price: 9.9 });
    expect(intent.inputSchema).toEqual({ name: { type: "string", required: true } });
    expect(intent.actionLabel).toBe("Create product");
    // Confidence is irrelevant on the interrupt path → fixed at 1, no missing
    // fields surfaced.
    expect(intent.confidence).toBe(1);
    expect(intent.missingFields).toEqual([]);
  });

  test("threads alternatives through so swapAlternative keeps working", () => {
    const meta = readActionApprovalMetadata(
      interrupt({
        metadata: {
          action: "a",
          inputDigest: "d",
          actionLabel: "A",
          alternatives: [
            { action: "b", input: {}, confidence: 0.6, missingFields: [], explanation: "maybe b" },
          ],
        },
      }),
    );
    if (!meta) throw new Error("expected metadata");
    expect(interruptToIntent(meta).alternatives).toHaveLength(1);
  });
});

describe("buildApproveAnswer / buildCancelAnswer", () => {
  test("Approve answer carries { action, input, baseDigest } from the edited input + interrupt digest", () => {
    // The Approve path: the card raises { action, input }; the parent supplies
    // baseDigest from the interrupt's metadata.inputDigest (anti-TOCTOU, §6.2).
    const answer = buildApproveAnswer({
      action: "create_product",
      input: { name: "X", price: 8.9 },
      inputDigest: "digest_abc",
    });
    expect(answer).toEqual({
      status: "resolved",
      payload: {
        action: "create_product",
        input: { name: "X", price: 8.9 },
        baseDigest: "digest_abc",
      },
    });
  });

  test("a swapped-in action is carried verbatim (server validates set membership)", () => {
    const answer = buildApproveAnswer({ action: "update_product", input: {}, inputDigest: "d" });
    expect(answer).toMatchObject({ status: "resolved", payload: { action: "update_product" } });
  });

  test("Cancel answer is status cancelled with no payload", () => {
    expect(buildCancelAnswer()).toEqual({ status: "cancelled" });
  });
});
