/**
 * AI Assistant — Side panel with chat-like interface.
 *
 * Slides in from the right (Shadcn Sheet). Users can ask questions
 * about their data, get action suggestions, and interact with the
 * AI service. Context-aware: knows which schema/record is being viewed.
 *
 * Supports AI Action Execution: when an intent is resolved, an
 * ActionProposalCard is rendered inline for user confirmation.
 */

import {
  Badge,
  Button,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@linchkit/ui-kit/components";
import { useParams } from "@tanstack/react-router";
import { BotIcon, Loader2Icon, SendIcon, SparklesIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { IntentResolution } from "../lib/api";
import { resolveIntent } from "../lib/api";
import { ActionProposalCard } from "./action-proposal-card";

// ── Types ────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  suggestions?: Array<{ action: string; label: string }>;
  /** When set, this message renders an ActionProposalCard instead of text */
  intent?: IntentResolution;
  timestamp: Date;
  /** Whether this message is still being streamed */
  streaming?: boolean;
}

// ── API ──────────────────────────────────────────────────

/**
 * Stream AI chat response via SSE.
 * Sends chunks to onChunk callback as they arrive, then
 * calls onDone with extracted suggestions when complete.
 */
async function streamAIChat(
  message: string,
  context: { schema?: string; recordId?: string },
  onChunk: (chunk: string) => void,
  onDone: (suggestions: Array<{ action: string; label: string }>) => void,
  onError: (error: string) => void,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  try {
    const res = await fetch("/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, context, stream: true }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const data = await res.json().catch(() => null);
      onError(data?.error?.message ?? `Request failed (${res.status})`);
      return;
    }

    const reader = res.body?.getReader();
    if (!reader) {
      onError("No response body");
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events from buffer
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6);
        try {
          const event = JSON.parse(jsonStr);
          if (event.done) {
            onDone(event.suggestions ?? []);
          } else if (event.error) {
            onError(event.error);
          } else if (event.chunk !== undefined) {
            onChunk(event.chunk);
          }
        } catch {
          // Ignore malformed JSON lines
        }
      }
    }

    // If stream ended without a done event, finalize
    onDone([]);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      onError("Request timed out. Please try again.");
    } else {
      onError("Failed to connect to AI service");
    }
  } finally {
    clearTimeout(timeout);
  }
}

// ── Component ────────────────────────────────────────────

export function AIAssistant({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const params = useParams({ strict: false }) as { name?: string; id?: string };
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Focus input when panel opens
  useEffect(() => {
    if (open && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: trimmed,
      timestamp: new Date(),
    };

    const assistantMsgId = `ai-${Date.now()}`;
    const chatContext = { schema: params.name, recordId: params.id };

    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    // Try intent resolution first — if it matches, skip streaming chat
    let intentResult: IntentResolution | null = null;
    try {
      intentResult = await resolveIntent(trimmed, chatContext);
    } catch {
      // Intent resolution is best-effort
    }

    if (intentResult && intentResult.confidence >= 0.5) {
      const proposalMsg: ChatMessage = {
        id: `proposal-${Date.now()}`,
        role: "assistant",
        content: intentResult.explanation,
        intent: intentResult,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, proposalMsg]);
      setLoading(false);
      return;
    }

    // Add an empty streaming assistant message
    setMessages((prev) => [
      ...prev,
      {
        id: assistantMsgId,
        role: "assistant",
        content: "",
        timestamp: new Date(),
        streaming: true,
      },
    ]);

    let doneReceived = false;

    await streamAIChat(
      trimmed,
      chatContext,
      // onChunk — append text to the streaming message
      (chunk) => {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMsgId
              ? { ...msg, content: msg.content + chunk }
              : msg,
          ),
        );
      },
      // onDone — finalize the message with suggestions
      (suggestions) => {
        if (doneReceived) return;
        doneReceived = true;
        setMessages((prev) =>
          prev.map((msg) => {
            if (msg.id !== assistantMsgId) return msg;
            // Strip suggestion HTML comment from displayed content
            let content = msg.content;
            const suggestionsMatch = content.match(
              /<!-- suggestions:\[.*?\] -->/s,
            );
            if (suggestionsMatch) {
              content = content.replace(/<!-- suggestions:\[.*?\] -->/s, "").trim();
            }
            return {
              ...msg,
              content: content || t("ai.noResponse"),
              suggestions: suggestions.length > 0 ? suggestions : undefined,
              streaming: false,
            };
          }),
        );
        setLoading(false);
      },
      // onError — show error in the assistant message
      (error) => {
        if (doneReceived) return;
        doneReceived = true;
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === assistantMsgId
              ? { ...msg, content: msg.content || error, streaming: false }
              : msg,
          ),
        );
        setLoading(false);
      },
    );

    // Safety net: if stream ends without calling onDone/onError
    if (!doneReceived) {
      setLoading(false);
    }
  }, [input, loading, params.name, params.id, t]);

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
  }, []);

  const handleSuggestionClick = useCallback((action: string) => {
    setInput(`Execute action: ${action}`);
  }, []);

  const handleActionComplete = useCallback(
    (result: { success: boolean; data?: unknown; error?: { message: string } }) => {
      const resultMsg: ChatMessage = {
        id: `result-${Date.now()}`,
        role: "assistant",
        content: result.success
          ? t("ai.actionSuccess")
          : (result.error?.message ?? t("ai.actionExecFailed")),
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, resultMsg]);
    },
    [t],
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col p-0 sm:max-w-md"
        showCloseButton
      >
        {/* Header */}
        <SheetHeader className="border-b px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <SparklesIcon className="size-4 text-primary" />
              <SheetTitle className="text-sm">{t("ai.title")}</SheetTitle>
            </div>
            {messages.length > 0 && (
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
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-3 py-12 text-center text-muted-foreground">
                <BotIcon className="size-10 opacity-30" />
                <p className="text-sm">{t("ai.welcomeMessage")}</p>
                <div className="flex flex-wrap justify-center gap-1.5">
                  {[
                    t("ai.quickPrompt1"),
                    t("ai.quickPrompt2"),
                    t("ai.quickPrompt3"),
                  ].map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      className="rounded-full border px-3 py-1 text-xs transition-colors hover:bg-accent"
                      onClick={() => setInput(prompt)}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                {/* Render ActionProposalCard for intent messages */}
                {msg.intent ? (
                  <div className="w-full max-w-[90%]">
                    <ActionProposalCard
                      intent={msg.intent}
                      onComplete={handleActionComplete}
                    />
                  </div>
                ) : (
                  <div
                    className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                      msg.role === "user"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-foreground"
                    }`}
                  >
                    <p className="whitespace-pre-wrap">
                      {msg.content}
                      {msg.streaming && (
                        <span className="inline-block ml-0.5 w-1.5 h-4 bg-foreground/50 animate-pulse" />
                      )}
                    </p>
                    {msg.suggestions && msg.suggestions.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {msg.suggestions.map((s) => (
                          <button
                            key={s.action}
                            type="button"
                            className="rounded-md border border-primary/30 bg-background px-2 py-0.5 text-xs text-primary transition-colors hover:bg-primary/10"
                            onClick={() => handleSuggestionClick(s.action)}
                          >
                            {s.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}

            {loading && (!messages.length || messages[messages.length - 1]?.content === "") && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
                  <Loader2Icon className="size-3.5 animate-spin" />
                  {t("ai.thinking")}
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
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t("ai.inputPlaceholder")}
              rows={1}
              className="flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              style={{ maxHeight: "120px" }}
              disabled={loading}
            />
            <Button
              size="icon-sm"
              onClick={handleSend}
              disabled={!input.trim() || loading}
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
