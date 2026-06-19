/**
 * AG-UI HITL resume handler — the "resume → execute" half of the write path
 * (Spec 71 P2b). This is the SECURITY-CRITICAL phase: §6's anti-TOCTOU
 * defenses live here.
 *
 * Run A (propose) finished with an interrupt outcome and wrote a
 * server-authoritative store entry (P2a — `buildProposeInterrupt` →
 * `interruptStore.put`). Run B (resume) arrives as a SECOND, stateless HTTP
 * connection carrying `input.resume: ResumeEntry[]`. This handler enforces the
 * exact §6.7 ordering — **claim (synchronous, before any `await`) → validate
 * (async) → execute-or-release** — for every resume entry, then executes the
 * approved Action through CommandLayer with the re-resolved HUMAN actor
 * (§6.1: the permission/tenant/rule slots run unconditionally; approval is a
 * SECOND gate, never a bypass — §6.5: the model never writes, only this
 * handler calls `commandLayer.execute`, and only after a human `resolved`).
 *
 * Vocabulary note (§3.6): this is the AG-UI `Interrupt`/`resume` flow —
 * deliberately UNRELATED to core's evolution `ProposalEngine`. New HITL code
 * never imports `proposal-engine.ts`.
 *
 * Rejection surfacing (§6.2/§6.4):
 *  - A HARD rejection (unknown/consumed interrupt, action outside the vetted
 *    set, digest mismatch, expiry, cross-user, unauthenticated) THROWS an
 *    {@link AgUiResumeRejectedError}. The run endpoint maps a runner throw to a
 *    `RUN_ERROR` frame (run-endpoint.ts) — no execution happens.
 *  - A `cancelled` resume is NOT an error: the handler returns void (declined),
 *    the endpoint emits a plain success finish, and nothing is written.
 *  - A CommandLayer permission/rule/handler failure is a NORMAL finish with the
 *    error surfaced as a TOOL_CALL_RESULT (§6.4 execute-time enforcement) — the
 *    run does NOT crash.
 */

import type {
  AgUiEmit,
  InterruptStore,
  InterruptStoreEntry,
  ResumeEntry,
} from "@linchkit/cap-adapter-ag-ui";
import { EventType } from "@linchkit/cap-adapter-ag-ui";
import type { Actor, CommandLayer } from "@linchkit/core";
import { canonicalJson } from "./agui-interrupt";

/**
 * A hard resume rejection (Spec 71 §6.2/§6.3/§6.4). Thrown so the run endpoint
 * surfaces it as `RUN_ERROR` with NO `commandLayer.execute`. The `code` is a
 * stable machine string carried in the message so a reviewer / test can tell
 * which §6 defense fired without leaking sensitive detail to the client.
 */
export class AgUiResumeRejectedError extends Error {
  /** Stable rejection code (e.g. "resume.interrupt.unknown"). */
  readonly code: string;
  constructor(code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "AgUiResumeRejectedError";
    this.code = code;
  }
}

/** Stable rejection codes — one per §6 defense, surfaced in the RUN_ERROR message. */
export const RESUME_REJECT_CODES = {
  /** §6.2 p1 / §6.4: no live store entry (absent / already-consumed / claim lost). */
  unknownInterrupt: "resume.interrupt.unknown",
  /** §6.2 p2: payload.action is not a member of the server-vetted action set. */
  actionNotInSet: "resume.action.not_in_set",
  /** §6.2 p3: payload.baseDigest does not echo the stored inputDigest. */
  digestMismatch: "resume.digest.mismatch",
  /** §5 / §6.7: the interrupt's approval window has passed (server-authoritative). */
  expired: "resume.interrupt.expired",
  /** §6.3: no real authenticated human actor resolved — fail closed, never anonymous. */
  unauthenticated: "resume.actor.unauthenticated",
  /** §6.2 p5: the re-resolved actor / tenant does not match the proposing actor. */
  crossUser: "resume.actor.mismatch",
  /** A malformed resume payload (e.g. resolved with no action). */
  malformedPayload: "resume.payload.malformed",
} as const;

/**
 * The HITL approval provenance attached to the executed mutation via Spec 65
 * `ExecutionMeta` (§6.6). It rides on `commandLayer.execute({ meta })` so it
 * lands in the SAME Execution Log row as the write it authorized — a reviewer
 * querying execution #N sees the AI-proposed → human-approved chain atomically
 * joined to the mutation, with no separate side log to drift.
 *
 * Carried under the reserved `_hitl` key on the execution's TRUSTED `systemMeta`
 * channel (NOT external `meta`): the CommandLayer strips `_`-prefixed keys from
 * external `meta` before persisting it, so `meta._hitl` would never survive —
 * whereas `systemMeta` is the framework-trusted adapter-attribution path (the
 * same channel MCP uses for `_mcp_client_id`). `_hitl` is not a framework-
 * reserved key, so it rides `systemMeta` through to the execution-log record.
 */
export interface HitlApprovalProvenance {
  proposedAction: string;
  proposedInput: Record<string, unknown>;
  approvedAction: string;
  approvedInput: Record<string, unknown>;
  /** Per-key edits the human made vs the model's proposal (approve-with-edits). */
  editedVsProposedDelta: Record<string, { from: unknown; to: unknown }>;
  interruptId: string;
  /** The human actor who clicked Approve (NOT the model / a synthetic actor). */
  approvedBy: { type: string; id: string };
  /** ISO timestamp the approval was processed. */
  approvedAt: string;
}

/** The `resolved` resume payload shape the handler accepts (§4.2). */
interface ResolvedResumePayload {
  action: string;
  input: Record<string, unknown>;
  baseDigest: string;
}

/**
 * Narrow an opaque resume `payload` (upstream types it `any`) into the
 * `{ action, input, baseDigest }` shape. Returns `undefined` when it is not a
 * usable resolved payload (no action / no baseDigest) so the caller rejects it
 * as malformed rather than executing on a half-formed request.
 */
function parseResolvedPayload(payload: unknown): ResolvedResumePayload | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const obj = payload as Record<string, unknown>;
  const action = typeof obj.action === "string" ? obj.action.trim() : "";
  const baseDigest = typeof obj.baseDigest === "string" ? obj.baseDigest : "";
  if (!action || !baseDigest) return undefined;
  const input =
    typeof obj.input === "object" && obj.input !== null && !Array.isArray(obj.input)
      ? (obj.input as Record<string, unknown>)
      : {};
  return { action, input, baseDigest };
}

/** Compute the per-key edited-vs-proposed delta for audit provenance (§6.6). */
function computeEditedDelta(
  proposedInput: Record<string, unknown>,
  approvedInput: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const delta: Record<string, { from: unknown; to: unknown }> = {};
  const keys = new Set([...Object.keys(proposedInput), ...Object.keys(approvedInput)]);
  for (const key of keys) {
    const from = proposedInput[key];
    const to = approvedInput[key];
    if (canonicalJson(from) !== canonicalJson(to)) {
      delta[key] = { from, to };
    }
  }
  return delta;
}

/**
 * The re-resolved run-B identity for the resume/execute path (§6.3). The runner
 * MUST fail closed: pass `actor: undefined` when no real authenticated human
 * actor resolved — this handler then rejects (§6.3), never substituting an
 * anonymous / synthetic actor on the write path.
 */
export interface ResumeActorContext {
  /**
   * The re-resolved run-B human actor, or `undefined` when none resolved
   * (resolver missing / returned undefined). Fail-closed: `undefined` ⇒ reject.
   * NEVER pass `ANONYMOUS_ACTOR` or a synthetic system actor here.
   */
  actor: Actor | undefined;
  /** The re-resolved run-B tenant scope (must match the stored proposer tenant). */
  tenant: string | undefined;
}

/** Inputs to {@link runAgUiResume}. */
export interface RunAgUiResumeOptions {
  /** The AG-UI thread the resume answers (same `threadId` as run A). */
  threadId: string;
  /** The resume entries from `input.resume[]` (≥1 by the caller's check). */
  resume: ResumeEntry[];
  /** The cross-connection interrupt store (§6.7). */
  store: InterruptStore;
  /** CommandLayer — the SOLE write entry on the resume path (§6.1/§6.5). */
  commandLayer: CommandLayer;
  /** Re-resolved run-B actor + tenant (fail-closed — §6.3). */
  actorContext: ResumeActorContext;
  /** Emit AG-UI protocol events (TEXT_MESSAGE_*, TOOL_CALL_RESULT). */
  emit: AgUiEmit;
  /** Injectable clock for deterministic expiry tests. @default Date.now() */
  now?: number;
}

/**
 * Run the AG-UI HITL resume/execute path for every entry in `resume` (Spec 71
 * P2b). Per entry it enforces the §6.7 ordering and either executes the
 * approved Action (resolved + all checks pass), declines (cancelled), or throws
 * a hard rejection (any §6.2/§6.3 violation → the endpoint emits RUN_ERROR).
 *
 * Returns void on a clean finish (executed and/or declined). The first hard
 * rejection throws — a forged/mismatched resume aborts the whole run with
 * RUN_ERROR and NO write, which is the safe failure mode.
 */
export async function runAgUiResume(options: RunAgUiResumeOptions): Promise<void> {
  const { threadId, resume, store, commandLayer, actorContext, emit } = options;

  // Track whether an earlier entry already executed an IRREVERSIBLE write. Once
  // one has, a LATER entry's hard rejection must NOT throw a batch RUN_ERROR —
  // that would mask the committed write's TOOL_CALL_RESULT and tell the client a
  // committed mutation "failed". It is surfaced as that entry's own error result
  // instead. Before anything commits, a rejection throws → a clean RUN_ERROR with
  // NO write (the safe single-entry default the security tests assert).
  let committed = false;
  for (const entry of resume) {
    // §5 — expiry is evaluated PER ENTRY (a fresh `now`), not once for the whole
    // batch: a slow earlier `commandLayer.execute` must not let a later entry
    // pass the approval window using a stale timestamp. A test-injected `now`
    // stays constant (deterministic); otherwise each entry re-reads the clock.
    const now = options.now ?? Date.now();
    try {
      const outcome = await resumeOne({
        threadId,
        entry,
        store,
        commandLayer,
        actorContext,
        emit,
        now,
      });
      if (outcome === "executed") committed = true;
    } catch (err) {
      if (committed && err instanceof AgUiResumeRejectedError) {
        emitExecutionResult(emit, {
          interruptId: entry.interruptId,
          action: "(rejected)",
          success: false,
          error: `${err.code}: ${err.message}`,
        });
        continue;
      }
      throw err;
    }
  }
}

/**
 * Handle a single resume entry (the §6.7 claim → validate → execute/release).
 * Returns `"executed"` once `commandLayer.execute` has been called (an
 * irreversible write was attempted) or `"declined"` for a cancelled resume;
 * a hard rejection THROWS `AgUiResumeRejectedError` (no write).
 */
async function resumeOne(options: {
  threadId: string;
  entry: ResumeEntry;
  store: InterruptStore;
  commandLayer: CommandLayer;
  actorContext: ResumeActorContext;
  emit: AgUiEmit;
  now: number;
}): Promise<"executed" | "declined"> {
  const { threadId, entry, store, commandLayer, actorContext, emit, now } = options;
  const interruptId = entry.interruptId;

  // ── 1. CLAIM — synchronous, BEFORE any `await` (§6.2 p4, §6.7) and BEFORE the
  // cancelled/resolved split. The in-process store's `claim` is an atomic
  // synchronous read-and-set of `consumed`; there is NO `await` between this
  // line and the entry read, so two concurrent resumes for the same interrupt
  // serialize and only the first wins — a cancel and an approve can NEVER both
  // proceed. A claim of an absent / already-consumed entry returns false →
  // unknown-interrupt reject (§6.2 p1, §6.4) — the one-shot replay defense.
  //
  // The claim is unified across BOTH the cancelled and resolved paths on
  // purpose: an earlier version claimed-then-evicted in the cancelled branch
  // WITHOUT checking the claim result, so a cancel racing a concurrent approve
  // could evict the entry the approve had already legitimately claimed (the
  // approve then read `undefined` and failed). Claiming first, once, for both
  // paths closes that race.
  const claimed = store.claim(threadId, interruptId);
  if (!claimed) {
    throw new AgUiResumeRejectedError(
      RESUME_REJECT_CODES.unknownInterrupt,
      "no live interrupt for this resume (absent, already-consumed, or replayed)",
    );
  }

  // From here the claim is HELD. Any hard validation failure must `evict`
  // (genuine reject — burn the entry); a transient/recoverable failure must
  // `release` (so a legitimate retry by the rightful proposer is still
  // possible). On success we `evict` (consumed). We never leave a held claim.
  try {
    // ── Cancelled: the claim is held (one-shot spent), so any concurrent
    // resolved-resume for the same interrupt already lost the claim and was
    // rejected. Decline, evict, NO write (§5 cancelled).
    if (entry.status === "cancelled") {
      store.evict(threadId, interruptId);
      emitDeclined(emit, interruptId, entry.interruptId);
      return "declined";
    }

    // Reject ANY status that is neither "cancelled" nor "resolved" BEFORE the
    // execute path. Only an explicit human "resolved" may execute; a malformed
    // or unexpected status value must never fall through and claim+execute on a
    // valid payload — that would weaken the server-side approval gate.
    if (entry.status !== "resolved") {
      throw new AgUiResumeRejectedError(
        RESUME_REJECT_CODES.malformedPayload,
        `unsupported resume status "${String(entry.status)}"`,
      );
    }

    // The claim mutated stored `consumed`; re-read the full entry to validate.
    const stored = store.get(threadId, interruptId);
    if (!stored) {
      // Raced eviction between claim and read — treat as unknown (no execute).
      throw new AgUiResumeRejectedError(
        RESUME_REJECT_CODES.unknownInterrupt,
        "interrupt entry vanished after claim",
      );
    }

    // ── 2. VALIDATE — async allowed now (the claim is held).

    const payload = parseResolvedPayload(entry.payload);
    if (!payload) {
      throw new AgUiResumeRejectedError(
        RESUME_REJECT_CODES.malformedPayload,
        "resolved resume requires { action, input, baseDigest }",
      );
    }

    // §6.2 p2 — action MUST be a member of the server-vetted set (primary +
    // offered alternatives). NOT asserted equal-to-primary (a legitimate swap
    // to a server-offered alternative is allowed); but the client can never
    // introduce an action the server did not author into the interrupt.
    if (!stored.actionSet.includes(payload.action)) {
      throw new AgUiResumeRejectedError(
        RESUME_REJECT_CODES.actionNotInSet,
        `action "${payload.action}" is not in the server-vetted set`,
      );
    }

    // §6.2 p3 — baseDigest MUST echo the stored inputDigest. This is the INTERRUPT
    // ANCHOR (anti-replay): it proves the client is answering THIS proposal, not
    // replaying a resume meant for a different interrupt. It is NOT a per-(action,
    // input) MAC — so for a swapped alternative the baseDigest still echoes this
    // interrupt's inputDigest (computed from the PRIMARY action+input at propose
    // time). The three gates are orthogonal: (a) the digest binds the resume to
    // this interrupt; (b) `actionSet.includes(action)` (above) authorizes WHICH
    // action — only one the server vetted and offered; (c) CommandLayer's own
    // schema + permission/tenant/rule slots (below) authorize the (possibly
    // edited) input. We deliberately do NOT require editedInput === proposedInput
    // — approve-with-edits is legitimate, and the edited input is validated by
    // CommandLayer, the authoritative gate for input integrity.
    if (payload.baseDigest !== stored.inputDigest) {
      throw new AgUiResumeRejectedError(
        RESUME_REJECT_CODES.digestMismatch,
        "baseDigest does not match the proposal's inputDigest",
      );
    }

    // §5 / §6.7 — expiry is SERVER-authoritative (never trust the client clock).
    // `Date.parse` returns NaN for a malformed/corrupt `expiresAt`, and EVERY
    // comparison with NaN is false — so a bad timestamp would SILENTLY disable
    // the gate and treat an expired interrupt as live. Treat an unparseable
    // window as expired (FAIL CLOSED).
    const expiresAtMs = Date.parse(stored.expiresAt);
    if (Number.isNaN(expiresAtMs) || now >= expiresAtMs) {
      // Genuine reject — the window closed (or is unparseable); evict (catch).
      throw new AgUiResumeRejectedError(
        RESUME_REJECT_CODES.expired,
        "the approval window has passed",
      );
    }

    // §6.3 — FAIL CLOSED on the write path: a missing/undefined actor is NEVER
    // substituted with ANONYMOUS_ACTOR or a synthetic system actor. No real
    // authenticated human ⇒ reject, no execute.
    const actor = actorContext.actor;
    if (!actor) {
      throw new AgUiResumeRejectedError(
        RESUME_REJECT_CODES.unauthenticated,
        "no authenticated human actor resolved on the resume/write path",
      );
    }

    // §6.2 p5 — the re-resolved actor identity AND tenant MUST equal the stored
    // proposer. Fail-closed-on-unauthenticated (above) is necessary but NOT
    // sufficient: a DIFFERENT authenticated user (user B) resuming user A's
    // interrupt clears the auth check yet never saw A's proposal. Bind to the
    // proposer captured on run A and reject a mismatch — even an authenticated
    // resumer — with NO execute. Only the human who saw the proposal may approve.
    const proposerMatches =
      actor.id === stored.proposerActor.id && actor.type === stored.proposerActor.type;
    const tenantMatches = (actorContext.tenant ?? undefined) === (stored.tenant ?? undefined);
    if (!proposerMatches || !tenantMatches) {
      throw new AgUiResumeRejectedError(
        RESUME_REJECT_CODES.crossUser,
        "the resuming actor / tenant does not match the proposing actor",
      );
    }

    // ── 3. EXECUTE (§6.1) — the SECOND gate is human approval; the FIRST
    // (permission/tenant/rule slots) still runs UNCONDITIONALLY through
    // CommandLayer. This is the ONLY `commandLayer.execute` on the assistant
    // path (§6.5). A permission/rule/handler failure is a NORMAL finish with
    // the error surfaced — not a crash.
    const provenance = buildProvenance({ stored, payload, actor, now });
    let result: { success: boolean; data?: unknown; executionId?: string };
    try {
      result = await commandLayer.execute({
        command: payload.action,
        input: payload.input,
        actor,
        tenantId: actorContext.tenant,
        // The assistant write originates from the admin UI surface (the AG-UI
        // panel) — `"ui"` is the closest existing ExecutionChannel.
        channel: "ui",
        // §6.6 audit provenance on Spec 65 ExecutionMeta. It MUST ride on the
        // TRUSTED `systemMeta` channel (Spec 65 §3.3 — the same adapter-
        // attribution path MCP's `_mcp_client_id` uses), NOT `meta`: external
        // `_`-prefixed `meta` keys are silently STRIPPED by `createExecutionMeta`
        // (execution-meta.ts), so provenance under `meta._hitl` would never
        // persist. The runner is a framework-trusted server adapter, so the
        // `_hitl` system key (non-framework-reserved) survives via `systemMeta`
        // and lands in the SAME execution-log row as the mutation it authorized.
        systemMeta: { _hitl: provenance },
      });
    } catch (execErr) {
      // CommandLayer threw (vs returning success:false) — surface as a normal
      // tool result, NOT a RUN_ERROR. The entry is consumed (claim held); a
      // re-propose is required to retry, so evict (handled in the outer catch
      // by rethrowing? No — this is an execute-time outcome, not a resume
      // rejection). Spend the entry and finish cleanly.
      store.evict(threadId, interruptId);
      emitExecutionResult(emit, {
        interruptId,
        action: payload.action,
        success: false,
        error: execErr instanceof Error ? execErr.message : "Action execution failed",
      });
      return "executed";
    }

    // Executed (success or business failure) — the one-shot is spent. Evict.
    store.evict(threadId, interruptId);
    emitExecutionResult(emit, {
      interruptId,
      action: payload.action,
      success: result.success,
      data: result.success ? result.data : undefined,
      executionId: result.executionId,
      error: result.success ? undefined : "Action failed",
    });
    return "executed";
  } catch (err) {
    // A hard rejection (the §6.2/§6.3 throws above): evict the entry (genuine
    // reject — the one shot is burned) and rethrow so the endpoint emits
    // RUN_ERROR with no execution. NOTE: a transient/recoverable validation
    // failure would `release` instead of `evict`; in P2b every validation
    // failure above is a HARD mismatch (action-set / digest / identity / expiry
    // / unauthenticated / malformed), so all of them evict — there is no
    // transient class on this path yet. (The store's `release` is wired and
    // unit-tested for the future durable-store retry case — §6.7.)
    if (err instanceof AgUiResumeRejectedError) {
      store.evict(threadId, interruptId);
    } else {
      // Unexpected (non-rejection) error after the claim — release so a
      // legitimate retry is possible (transient), then rethrow.
      store.release(threadId, interruptId);
    }
    throw err;
  }
}

/** Assemble the §6.6 audit provenance for the executed mutation. */
function buildProvenance(options: {
  stored: InterruptStoreEntry;
  payload: ResolvedResumePayload;
  actor: Actor;
  now: number;
}): HitlApprovalProvenance {
  const { stored, payload, actor, now } = options;
  return {
    proposedAction: stored.proposedAction,
    proposedInput: stored.proposedInput,
    approvedAction: payload.action,
    approvedInput: payload.input,
    editedVsProposedDelta: computeEditedDelta(stored.proposedInput, payload.input),
    interruptId: stored.interruptId,
    approvedBy: { type: actor.type, id: actor.id },
    approvedAt: new Date(now).toISOString(),
  };
}

/** Emit a declined-finish text message (cancelled resume — no write). */
function emitDeclined(emit: AgUiEmit, interruptId: string, _echo: string): void {
  const messageId = crypto.randomUUID();
  emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" });
  emit({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId,
    delta: "The proposed change was declined. Nothing was executed.",
  });
  emit({ type: EventType.TEXT_MESSAGE_END, messageId });
  // The interruptId is referenced for audit symmetry with the execute path; the
  // declined finish carries no protocol outcome (a plain success finish).
  void interruptId;
}

/**
 * Emit the executed-mutation result as a TOOL_CALL_RESULT plus a short
 * assistant text. The toolCallId ties the result back to the proposeMutation
 * tool-call carrier (reserved-prefixed) so the UI can correlate it to the card.
 */
function emitExecutionResult(
  emit: AgUiEmit,
  result: {
    interruptId: string;
    action: string;
    success: boolean;
    data?: unknown;
    executionId?: string;
    error?: string;
  },
): void {
  const content = result.success
    ? { success: true, action: result.action, executionId: result.executionId, data: result.data }
    : { success: false, action: result.action, error: result.error };
  emit({
    type: EventType.TOOL_CALL_RESULT,
    messageId: crypto.randomUUID(),
    // The interrupt's reserved-prefixed tool-call id correlates the result to
    // the original proposal carrier (§4.2). Kept in sync with the runner's id.
    toolCallId: `lk:propose-mutation:${result.interruptId}`,
    // Guard serialization: by the time this runs the mutation has ALREADY
    // committed and the interrupt is evicted, so a `JSON.stringify` throw on the
    // action-returned `data` (circular structure / BigInt) must NOT bubble into
    // a RUN_ERROR that tells the client a committed write failed. On failure we
    // drop the un-encodable `data` and keep the result envelope.
    content: safeJsonStringify(content),
    role: "tool",
  });

  const messageId = crypto.randomUUID();
  emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" });
  emit({
    type: EventType.TEXT_MESSAGE_CONTENT,
    messageId,
    delta: result.success
      ? `Done — executed "${result.action}".`
      : `Could not execute "${result.action}": ${result.error ?? "action failed"}.`,
  });
  emit({ type: EventType.TEXT_MESSAGE_END, messageId });
}

/**
 * Stringify a tool-result envelope whose `data` is an action-returned value of
 * unknown shape. If `JSON.stringify` throws (a circular structure or a `BigInt`),
 * drop the un-encodable `data` and keep the rest — the mutation has already
 * committed, so the client must still get a coherent success result, never a
 * RUN_ERROR for a write that landed.
 */
function safeJsonStringify(envelope: Record<string, unknown>): string {
  try {
    return JSON.stringify(envelope);
  } catch {
    const { data: _data, ...rest } = envelope;
    return JSON.stringify({ ...rest, data: "[result data omitted — not serializable]" });
  }
}
