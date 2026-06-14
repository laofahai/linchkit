/**
 * Deterministic AG-UI assistant model stub — browser-e2e ONLY (Spec 71 P5 §8).
 *
 * WHY THIS EXISTS
 * ---------------
 * The §8 browser e2e must prove the HITL UI chain end-to-end:
 *   chat send → proposeMutation interrupt → ActionProposalCard in the stream →
 *   edit + Approve → resume[] → CommandLayer execute → record exists → success.
 *
 * A run that depends on a LIVE third-party model (GLM) DECIDING to call
 * `proposeMutation` is non-deterministic and flaky in CI — the model might
 * answer in prose, propose a different action, or shape the args differently.
 * The REAL-provider path is already live-proven at the HTTP level (#609 keystone
 * + the agui-runner HITL unit tests). The browser e2e's job is to prove the UI
 * RENDER + click → resume → record chain RELIABLY, not to re-test the model.
 *
 * So for the e2e ONLY (gated behind `LINCHKIT_AGUI_STUB_MODEL=1` at the server
 * boot seam — routes/agui-api.ts), the runner uses this `MockLanguageModelV3`
 * instead of a provider. It always answers with a short line and then a single
 * `proposeMutation{create_product,{name:"Widget", unit_price:9.9}}` tool-call,
 * then stops (an un-executed tool call ends the run — the runner then emits the
 * interrupt outcome). This is the SAME `MockLanguageModelV3` seam the server
 * unit tests use (ai/test), wired in via env. NEVER imported on a real boot:
 * routes/agui-api.ts only imports this module when the env flag is "1".
 *
 * Determinism note: the product entity's price field is `unit_price` (not
 * `price`); the stub proposes the real field so the executed CommandLayer write
 * lands a valid record the e2e can query.
 */

import { convertArrayToReadableStream, MockLanguageModelV3 } from "ai/test";
import { PROPOSE_MUTATION_TOOL_NAME, type ProposeMutationArgs } from "./tools";

/** The action + input the stub always proposes (Spec 71 P5 §8). */
export const E2E_STUB_PROPOSAL: ProposeMutationArgs = {
  action: "create_product",
  // The product catalog entity's price field is `unit_price` (see
  // cap-purchase-demo product.ts). The e2e edits this 9.9 → 8.9 before Approve.
  input: { name: "Widget", unit_price: 9.9 },
};

/** The V3 stream-part type, derived from the mock so we add no provider dep. */
type V3StreamPart =
  Awaited<ReturnType<MockLanguageModelV3["doStream"]>>["stream"] extends ReadableStream<infer PART>
    ? PART
    : never;

/**
 * Build the deterministic `proposeMutation`-calling stub model. Every run emits
 * a short assistant line, then a single `proposeMutation` tool-call with
 * {@link E2E_STUB_PROPOSAL}, then finishes — exactly the chunk sequence the
 * runner's fullStream loop captures + suppresses (§4.5) to emit the interrupt.
 */
export function buildProposeMutationStubModel(): MockLanguageModelV3 {
  const chunks: V3StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    {
      type: "text-delta",
      id: "t1",
      delta: "Sure — here's a draft for you to review and approve.",
    },
    { type: "text-end", id: "t1" },
    {
      type: "tool-call",
      // A fresh id per call would be ideal, but the mock replays one static
      // stream; the runner mints its OWN reserved-prefixed interrupt toolCallId
      // anyway (§4.2), so this raw id is never surfaced to the client.
      toolCallId: "e2e-stub-propose",
      toolName: PROPOSE_MUTATION_TOOL_NAME,
      input: JSON.stringify(E2E_STUB_PROPOSAL),
    },
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool-calls" },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
    },
  ];

  return new MockLanguageModelV3({
    // A fresh ReadableStream per `doStream` call: the assistant panel can issue
    // more than one run (e.g. a retry), and a ReadableStream is single-use.
    doStream: async () => ({ stream: convertArrayToReadableStream(chunks) }),
  });
}
