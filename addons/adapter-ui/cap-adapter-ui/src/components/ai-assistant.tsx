/**
 * AI Assistant — Side panel with chat-like interface.
 *
 * Uses Vercel AI SDK's useChat hook for:
 * - Full conversation history (stateful across messages)
 * - Built-in streaming via UI message protocol
 * - Tool/function calling support (server-side tools rendered automatically)
 * - Context-aware: passes current schema/record context with each request
 *
 * Runtime-data write governance (Spec 71): a chat send goes STRAIGHT to the
 * AG-UI stream. When the model wants to mutate data it calls the execute-less
 * `proposeMutation` tool, which interrupts the run; the interrupt surfaces an
 * `ActionProposalCard` (via {@link pendingInterrupts}), the human approves, and
 * the resume round-trip executes the Action through CommandLayer. This is the
 * ONE runtime-data write path. The old `resolveIntent`→`proposals[]` REST side
 * channel that rendered a card OUTSIDE the stream was removed in P4 (Spec 71
 * §2.2 / §2.6 — dismantle the side channel, not the server-side resolver).
 *
 * Schema-change utterances ("raise the manager-approval threshold to 20000")
 * are a DIFFERENT, governed code-graduation path (the 4th "say → exists"
 * channel): before falling through to the stream, `handleSend` asks
 * `resolveSchemaIntent` whether the prompt is a graduable schema change and, if
 * so, renders a {@link SchemaProposalCard}. This is NOT a runtime-data mutation
 * (§3.6 naming-collision note) and is intentionally preserved.
 */

import type { Interrupt as AgUiInterrupt } from "@ag-ui/client";
import { isInterruptExpired } from "@ag-ui/client";
import { useChat } from "@ai-sdk/react";
import {
  Badge,
  Button,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@linchkit/ui-kit/components";
import { useParams } from "@tanstack/react-router";
import type { UIMessage, UIMessageChunk } from "ai";
import { BotIcon, Loader2Icon, SendIcon, SparklesIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgUiChatTransport } from "../lib/agui-chat-transport";
import {
  type ActionApprovalMetadata,
  buildApproveAnswer,
  buildCancelAnswer,
  interruptToIntent,
  readActionApprovalMetadata,
  readInterruptChunk,
} from "../lib/agui-interrupt";
import {
  type ResolveSchemaIntentResult,
  resolveSchemaIntent,
  type SchemaIntentDraft,
} from "../lib/ai-api";
import { isAiEnabled } from "../lib/app-config";
import { ActionProposalCard } from "./action-proposal-card";
import { MessageBubble } from "./ai-message-bubble";
import { SchemaProposalCard } from "./schema-proposal-card";

// ── Proposal state ───────────────────────────────────────

/**
 * A schema-change draft surfaced by the chat assistant — the 4th "say → exists"
 * channel. Minted by `resolveSchemaIntent`; carried through Approve → Open PR by
 * {@link SchemaProposalCard}. This is a code-graduation draft, NOT a runtime-data
 * mutation (§3.6 naming-collision note).
 */
interface SchemaProposalItem {
  id: string;
  draft: SchemaIntentDraft;
}

/**
 * An open AG-UI HITL interrupt surfaced by the transport (Spec 71 §4.4) — the
 * native runtime-data write-governance path and, after P4, the ONLY one. Holds
 * the raw interrupt (for the `resume[]` round-trip + `isInterruptExpired`
 * gating) and its validated action-approval metadata (the `ActionProposalCard`
 * source).
 */
interface PendingInterruptItem {
  interrupt: AgUiInterrupt;
  meta: ActionApprovalMetadata;
}

function createTextMessage(role: "user" | "assistant", text: string): UIMessage {
  return {
    id: crypto.randomUUID(),
    role,
    parts: [{ type: "text", text }],
  };
}

/**
 * Summarize the server's resume `TOOL_CALL_RESULT` (`lk:propose-mutation:<id>`)
 * into a one-line assistant message when the resume run streamed no text of its
 * own. The payload shape is the server contract (§4.1): `{ success, action,
 * executionId, data }` or `{ success:false, action, error }`.
 */
export function summarizeResumeResult(
  result: unknown,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (!result || typeof result !== "object") return "";
  const r = result as { success?: unknown; action?: unknown; error?: unknown };
  const action = typeof r.action === "string" ? r.action : "";
  if (r.success === false) {
    const reason = typeof r.error === "string" ? r.error : t("ai.actionExecFailed");
    return t("ai.actionFailedNamed", {
      action,
      reason,
      defaultValue: `Failed to run ${action || "the action"}: ${reason}`,
    });
  }
  if (r.success === true) {
    return t("ai.actionSucceededNamed", {
      action,
      defaultValue: `Done — ran ${action || "the action"}.`,
    });
  }
  return "";
}

// ── Schema-intent fallback routing (4th "say → exists" channel) ─

/**
 * Outcome of inspecting a `resolveSchemaIntent` result. Exported as a pure
 * helper so the decision can be unit-tested without mounting the component
 * (the test setup is logic-only — no jsdom).
 *
 *  - `schema-proposal` — render a {@link SchemaProposalCard} for the draft.
 *  - `chat-fallback`   — let the AG-UI stream take the prompt
 *                        (`clarification` / `no_match` / `unavailable` /
 *                        `error` — none is a graduable schema change).
 */
export type SchemaFallbackDecision =
  | { kind: "schema-proposal"; draft: SchemaIntentDraft }
  | { kind: "chat-fallback" };

/**
 * Pure routing helper — maps a `ResolveSchemaIntentResult` onto the UX action
 * the assistant should take. Only a `proposal_draft` (the client maps both
 * `proposal_draft` and `entity_proposal_draft` here) becomes a card; every
 * other outcome falls through to chat so read-only Q&A keeps working.
 */
export function decideSchemaFallback(outcome: ResolveSchemaIntentResult): SchemaFallbackDecision {
  if (outcome.kind === "proposal_draft") {
    return { kind: "schema-proposal", draft: outcome.draft };
  }
  return { kind: "chat-fallback" };
}

// ── Component ────────────────────────────────────────────

export function AIAssistant({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const params = useParams({ strict: false }) as { name?: string; id?: string };
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Pending schema-change drafts from schema-intent resolution (4th channel).
  const [schemaProposals, setSchemaProposals] = useState<SchemaProposalItem[]>([]);
  // Open AG-UI HITL interrupts surfaced by the transport (Spec 71 §4.4) — the
  // native (and, after P4, sole) runtime-data write-governance path.
  const [pendingInterrupts, setPendingInterrupts] = useState<PendingInterruptItem[]>([]);
  // True while the schema-intent resolver round-trips before a chat send.
  const [isResolvingIntent, setIsResolvingIntent] = useState(false);

  // AG-UI transport (#89) — same assistant brain as /api/ai/chat, but over
  // the official AG-UI protocol via @ag-ui/client. Page context (entity +
  // record + locale) travels as AG-UI context entries with each run.
  const transport = useMemo(
    () =>
      new AgUiChatTransport({
        api: "/api/agui/run",
        context: () => ({
          entity: params.name,
          recordId: params.id,
          locale: i18n.language,
        }),
      }),
    [params.name, params.id, i18n.language],
  );

  // Vercel AI SDK useChat — manages conversation history, streaming, and tool calls
  const {
    id: chatId,
    messages,
    setMessages,
    sendMessage,
    status,
    error,
    stop,
  } = useChat({
    transport,
    onError: (err) => {
      console.error("[AI Assistant] Error:", err);
    },
    // Spec 71 §4.5 — the transport surfaces an interrupt outcome as a transient
    // `data-lk-interrupt` chunk; pick it up here, validate each interrupt's
    // action-approval metadata, and queue it for the ActionProposalCard.
    onData: (part) => {
      const interrupts = readInterruptChunk(part);
      if (!interrupts) return;
      // Defensively dedupe by interrupt id — a stream reconnect / buffering could
      // re-deliver the same interrupt chunk, which would otherwise render a
      // duplicate card for the same pending approval.
      setPendingInterrupts((prev) => {
        const seen = new Set(prev.map((p) => p.interrupt.id));
        const next = [...prev];
        for (const interrupt of interrupts) {
          if (seen.has(interrupt.id)) continue;
          const meta = readActionApprovalMetadata(interrupt);
          if (!meta) continue;
          next.push({ interrupt, meta });
          seen.add(interrupt.id);
        }
        return next.length === prev.length ? prev : next;
      });
    },
  });

  const isLoading = status === "submitted" || status === "streaming";

  // Fresh-value refs so the memoized resume handlers can read the current
  // chatId + history without re-creating (and thus re-rendering the cards) on
  // every keystroke / message append.
  const chatIdRef = useRef(chatId);
  const messagesRef = useRef(messages);
  chatIdRef.current = chatId;
  messagesRef.current = messages;

  // Auto-scroll to bottom when messages or cards change
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages and cards are triggers, not deps used inside
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, schemaProposals, pendingInterrupts]);

  // Focus input when panel opens
  useEffect(() => {
    if (open && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  // Remove a schema proposal card. Called on graduation success (the PR is
  // open — nothing more to do here) or on explicit dismiss. On approve/graduate
  // FAILURE the card stays (it owns its own error + retry), mirroring the
  // action-proposal "keep on failure" behavior above.
  const handleSchemaProposalRemove = useCallback((id: string) => {
    setSchemaProposals((prev) => prev.filter((p) => p.id !== id));
  }, []);

  // ── HITL interrupt resume (Spec 71 §4.1, run B) ──
  //
  // Drain the resume run's stream and surface a concise assistant message from
  // the server's `TOOL_CALL_RESULT` (`lk:propose-mutation:<id>` toolCallId) or
  // any streamed text. The card is dismissed regardless once the resume run
  // completes — the run is one-shot server-side (§6.7).
  const drainResumeStream = useCallback(
    async (stream: ReadableStream<UIMessageChunk>) => {
      let textOut = "";
      let toolResult: unknown;
      let streamError: string | undefined;
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value.type === "text-delta") textOut += value.delta;
          else if (value.type === "tool-output-available") toolResult = value.output;
          else if (value.type === "error")
            streamError = value.errorText || "Action execution failed";
        }
      } finally {
        reader.releaseLock();
      }
      // A server-side failure must NOT silently complete as success (which would
      // dismiss the card and tell the user the action ran). Surface it by
      // throwing so the card's onApprove catch shows the message and keeps the
      // card mounted for retry. Two failure shapes: a stream `error` chunk, and a
      // TOOL_CALL_RESULT carrying `success:false` (the §6.4 CommandLayer-denied
      // path, which arrives as a normal tool result, not an error chunk).
      if (streamError) throw new Error(streamError);
      const tr = toolResult as { success?: boolean; error?: string } | undefined;
      if (tr && tr.success === false) throw new Error(tr.error || "Action execution failed");
      const summary = textOut.trim() || summarizeResumeResult(toolResult, t);
      if (summary) setMessages((prev) => [...prev, createTextMessage("assistant", summary)]);
    },
    [setMessages, t],
  );

  // Approve an interrupt: build the resolved `resume[]` (`{ action, input,
  // baseDigest }`) and send run B. The model never writes directly — the
  // server executes the approved action through CommandLayer on resume.
  const handleInterruptApprove = useCallback(
    async (
      item: PendingInterruptItem,
      resume: { action: string; input: Record<string, unknown> },
    ) => {
      // Do NOT remove the card up front: it must stay mounted so the card's own
      // `executing` state is visible and a failure (thrown by drainResumeStream)
      // propagates to the card's onApprove catch to display the error + allow
      // retry. The card is dismissed ONLY after the resume run completes cleanly.
      const answer = buildApproveAnswer({
        action: resume.action,
        input: resume.input,
        inputDigest: item.meta.inputDigest,
      });
      const stream = await transport.sendResume({
        chatId: chatIdRef.current,
        messages: messagesRef.current,
        interrupts: [item.interrupt],
        answers: { [item.interrupt.id]: answer },
      });
      await drainResumeStream(stream); // throws on a server-side failure
      setPendingInterrupts((prev) => prev.filter((p) => p.interrupt.id !== item.interrupt.id));
    },
    [transport, drainResumeStream],
  );

  // Cancel an interrupt: send a `cancelled` resume (no payload) so the server
  // finishes the run with no write, then drop the card.
  const handleInterruptCancel = useCallback(
    async (item: PendingInterruptItem) => {
      try {
        const stream = await transport.sendResume({
          chatId: chatIdRef.current,
          messages: messagesRef.current,
          interrupts: [item.interrupt],
          answers: { [item.interrupt.id]: buildCancelAnswer() },
        });
        await drainResumeStream(stream);
      } catch (err) {
        console.error("[AI Assistant] interrupt cancel failed:", err);
      } finally {
        // A cancel has no write to recover, so the card is ALWAYS dismissed —
        // whether the cancel run succeeded or errored — but only after the run
        // completes (so the card doesn't vanish before the request is sent).
        setPendingInterrupts((prev) => prev.filter((p) => p.interrupt.id !== item.interrupt.id));
      }
    },
    [transport, drainResumeStream],
  );

  // Use an uncontrolled input approach since useChat v6 doesn't have handleInputChange
  const handleSend = useCallback(async () => {
    const textarea = inputRef.current;
    if (!textarea) return;
    const trimmed = textarea.value.trim();
    if (!trimmed || isLoading || isResolvingIntent) return;

    textarea.value = "";

    if (isAiEnabled()) {
      // ── 4th channel: schema-change governance (NOT a runtime-data mutation) ──
      //
      // Before handing the prompt to the AG-UI stream, ask whether it is a
      // graduable SCHEMA-change utterance ("raise the manager-approval threshold
      // to 20000") — `resolveSchemaIntent` mints a GOVERNED draft Proposal for
      // those. A `proposal_draft` / `entity_proposal_draft` (both mapped to
      // `proposal_draft` by the client) becomes a SchemaProposalCard. Every other
      // outcome (clarification / no_match / unavailable / error) falls through to
      // the stream, where the model handles read-only Q&A and proposes any
      // runtime-data mutation via `proposeMutation` → interrupt → ActionProposalCard
      // (the sole runtime-data write path after P4).
      setIsResolvingIntent(true);
      let schemaOutcome: ResolveSchemaIntentResult;
      try {
        schemaOutcome = await resolveSchemaIntent(trimmed);
      } catch (err) {
        // A thrown resolver (e.g. an auth/transport failure inside getAuthHeaders
        // or handleUnauthorized) must NOT leave `isResolvingIntent` stuck true —
        // that would permanently disable the input + send button. Treat it as a
        // non-graduable outcome so we fall through to the stream below.
        schemaOutcome = {
          kind: "error",
          message: err instanceof Error ? err.message : "schema intent resolution failed",
        };
      } finally {
        setIsResolvingIntent(false);
      }

      const schemaDecision = decideSchemaFallback(schemaOutcome);
      if (schemaDecision.kind === "schema-proposal") {
        // Echo the prompt for the card path (the stream echoes the user message
        // itself via `sendMessage`, so we only echo here).
        setMessages((prev) => [...prev, createTextMessage("user", trimmed)]);
        const id = crypto.randomUUID();
        setSchemaProposals((prev) => [...prev, { id, draft: schemaDecision.draft }]);
        return;
      }
      // Fall through to the stream — preserves read-only Q&A and runtime-data
      // mutations (via the model's `proposeMutation` tool) for prompts the schema
      // resolver did not classify as a graduable schema change.
    }

    // AI disabled OR the prompt is not a schema-change utterance: send it to the
    // AG-UI stream. Any runtime-data mutation surfaces there as a proposeMutation
    // interrupt → ActionProposalCard → resume (the one runtime-data write path).
    sendMessage({ text: trimmed });
  }, [isLoading, isResolvingIntent, sendMessage, setMessages]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleClear = useCallback(() => {
    setMessages([]);
    setSchemaProposals([]);
    setPendingInterrupts([]);
  }, [setMessages]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col p-0 sm:max-w-md" showCloseButton>
        {/* Header */}
        <SheetHeader className="border-b px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <SparklesIcon className="size-4 text-primary" />
              <SheetTitle className="text-sm">{t("ai.title")}</SheetTitle>
            </div>
            <div className="flex items-center gap-1">
              {isLoading && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={stop}
                  className="text-muted-foreground"
                  title={t("ai.stop")}
                >
                  <Loader2Icon className="size-3.5 animate-spin" />
                </Button>
              )}
              {(messages.length > 0 ||
                schemaProposals.length > 0 ||
                pendingInterrupts.length > 0) && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleClear}
                  className="text-muted-foreground"
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              )}
            </div>
          </div>
          {params.name && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>{t("ai.context")}:</span>
              <Badge variant="secondary" className="text-xs font-normal">
                {params.name}
                {params.id && ` #${params.id.slice(0, 8)}`}
              </Badge>
            </div>
          )}
        </SheetHeader>

        {/* Messages area */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4">
          <div className="flex flex-col gap-3 py-4">
            {messages.length === 0 &&
              schemaProposals.length === 0 &&
              pendingInterrupts.length === 0 && (
                <div className="flex flex-col items-center justify-center gap-3 py-12 text-center text-muted-foreground">
                  <BotIcon className="size-10 opacity-30" />
                  <p className="text-sm">{t("ai.welcomeMessage")}</p>
                  <div className="flex flex-wrap justify-center gap-1.5">
                    {[t("ai.quickPrompt1"), t("ai.quickPrompt2"), t("ai.quickPrompt3")].map(
                      (prompt) => (
                        <button
                          key={prompt}
                          type="button"
                          className="rounded-full border px-3 py-1 text-xs transition-colors hover:bg-accent"
                          onClick={() => {
                            if (inputRef.current) {
                              inputRef.current.value = prompt;
                              inputRef.current.focus();
                            }
                          }}
                        >
                          {prompt}
                        </button>
                      ),
                    )}
                  </div>
                </div>
              )}

            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}

            {/* Schema-change proposal cards (4th "say → exists" channel) —
                shown after the action cards. The card is removed ONLY on explicit
                dismiss: after graduation it stays in its `done` phase so the user
                can read and click the opened-PR link. Removing it on graduation
                would unmount it (React 19 batches the card's state updates with
                the parent removal) before that link ever renders. */}
            {schemaProposals.map((sp) => (
              <div key={sp.id} className="flex justify-start">
                <div className="w-full max-w-[95%]">
                  <SchemaProposalCard
                    draft={sp.draft}
                    onDismiss={() => handleSchemaProposalRemove(sp.id)}
                  />
                </div>
              </div>
            ))}

            {/* AG-UI HITL interrupt cards (Spec 71 §4.4) — the native write-
                governance path. Reuses the SAME ActionProposalCard, fed from
                the interrupt's metadata; Approve raises onApprove → resume[]
                round-trip (no direct executeAction). The Approve affordance is
                gated by isInterruptExpired: an expired interrupt renders a
                read-only notice instead of an actionable card (a late resume is
                rejected server-side anyway, §5/§6.7). */}
            {pendingInterrupts.map((item) =>
              isInterruptExpired(item.interrupt) ? (
                <div key={item.interrupt.id} className="flex justify-start">
                  <div className="w-full max-w-[95%] rounded-lg border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
                    {t("ai.interruptExpired", {
                      action: item.meta.actionLabel,
                      defaultValue: `This approval for "${item.meta.actionLabel}" expired.`,
                    })}
                  </div>
                </div>
              ) : (
                <div key={item.interrupt.id} className="flex justify-start">
                  <div className="w-full max-w-[95%]">
                    <ActionProposalCard
                      intent={interruptToIntent(item.meta)}
                      onApprove={(resume) => handleInterruptApprove(item, resume)}
                      onCancel={() => handleInterruptCancel(item)}
                    />
                  </div>
                </div>
              ),
            )}

            {/* Error display */}
            {error && (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error.message || t("ai.error")}
                </div>
              </div>
            )}

            {/* Loading indicator when submitted but no streaming content yet */}
            {status === "submitted" && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
                  <Loader2Icon className="size-3.5 animate-spin" />
                  {t("ai.thinking")}
                </div>
              </div>
            )}

            {/* Intent resolution indicator */}
            {isResolvingIntent && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-1.5 text-xs text-muted-foreground">
                  <Loader2Icon className="size-3 animate-spin" />
                  {t("ai.resolvingIntent")}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Input area */}
        <div className="border-t p-3">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              onKeyDown={handleKeyDown}
              placeholder={t("ai.inputPlaceholder")}
              rows={1}
              className="flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              style={{ maxHeight: "120px" }}
              disabled={isLoading || isResolvingIntent}
            />
            <Button
              size="icon-sm"
              onClick={() => void handleSend()}
              disabled={isLoading || isResolvingIntent}
            >
              <SendIcon className="size-3.5" />
            </Button>
          </div>
          <p className="mt-1.5 text-center text-[10px] text-muted-foreground">
            {t("ai.disclaimer")}
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// Message bubble + part rendering live in ai-message-bubble.tsx (extracted
// to keep this file under the 500-line limit).
