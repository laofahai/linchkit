/**
 * AI Assistant — Side panel with chat-like interface.
 *
 * Uses Vercel AI SDK's useChat hook for:
 * - Full conversation history (stateful across messages)
 * - Built-in streaming via UI message protocol
 * - Tool/function calling support (server-side tools rendered automatically)
 * - Context-aware: passes current schema/record context with each request
 *
 * When AI is enabled, also performs parallel intent resolution on each user
 * message. If a matching action is found (confidence >= 0.5), an
 * ActionProposalCard is shown inline — the user can confirm execution or cancel.
 */

import { useChat } from "@ai-sdk/react";
import {
  Badge,
  Button,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@linchkit/ui-kit/components";
import { DefaultChatTransport, getToolName, isToolUIPart } from "ai";
import type { UIMessage, UIMessagePart } from "ai";
import { useParams } from "@tanstack/react-router";
import {
  BotIcon,
  ExternalLinkIcon,
  Loader2Icon,
  SendIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActionProposalCard } from "./action-proposal-card";
import {
  isAiEnabled,
  resolveIntent,
  type ActionResult,
  type IntentResolution,
} from "../lib/api";

// ── Proposal state ───────────────────────────────────────

interface ProposalItem {
  id: string;
  intent: IntentResolution;
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

  // Pending action proposals from intent resolution
  const [proposals, setProposals] = useState<ProposalItem[]>([]);
  const [isResolvingIntent, setIsResolvingIntent] = useState(false);

  // Create transport with context-aware body (schema + record info + locale sent with each request)
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/ai/chat",
        body: () => ({
          context: {
            schema: params.name,
            recordId: params.id,
            locale: i18n.language,
          },
        }),
      }),
    [params.name, params.id, i18n.language],
  );

  // Vercel AI SDK useChat — manages conversation history, streaming, and tool calls
  const {
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
  });

  const isLoading = status === "submitted" || status === "streaming";

  // Auto-scroll to bottom when messages or proposals change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, proposals]);

  // Focus input when panel opens
  useEffect(() => {
    if (open && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  // Dismiss a proposal when user cancels
  const handleProposalCancel = useCallback((proposalId: string) => {
    setProposals((prev) => prev.filter((p) => p.id !== proposalId));
  }, []);

  // Remove proposal after execution completes (success or error)
  const handleProposalComplete = useCallback(
    (_proposalId: string, _result: ActionResult) => {
      setProposals((prev) => prev.filter((p) => p.id !== _proposalId));
    },
    [],
  );

  // Use an uncontrolled input approach since useChat v6 doesn't have handleInputChange
  const handleSend = useCallback(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    const trimmed = textarea.value.trim();
    if (!trimmed || isLoading) return;

    sendMessage({ text: trimmed });
    textarea.value = "";

    // Parallel intent resolution — fire and forget, graceful on failure
    if (isAiEnabled()) {
      setIsResolvingIntent(true);
      resolveIntent(trimmed, { schema: params.name, recordId: params.id })
        .then((result) => {
          if (result && result.confidence >= 0.5) {
            const proposalId = crypto.randomUUID();
            setProposals((prev) => [...prev, { id: proposalId, intent: result }]);
          }
        })
        .catch(() => {
          // AI unavailable — chat continues normally, no proposal shown
        })
        .finally(() => {
          setIsResolvingIntent(false);
        });
    }
  }, [isLoading, sendMessage, params.name, params.id]);

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
    setProposals([]);
  }, [setMessages]);

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
              {(messages.length > 0 || proposals.length > 0) && (
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
            {messages.length === 0 && proposals.length === 0 && (
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
                      onClick={() => {
                        if (inputRef.current) {
                          inputRef.current.value = prompt;
                          inputRef.current.focus();
                        }
                      }}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}

            {/* Action proposal cards — shown after chat messages */}
            {proposals.map((proposal) => (
              <div key={proposal.id} className="flex justify-start">
                <div className="w-full max-w-[95%]">
                  <ActionProposalCard
                    intent={proposal.intent}
                    onComplete={(result) => handleProposalComplete(proposal.id, result)}
                    onCancel={() => handleProposalCancel(proposal.id)}
                  />
                </div>
              </div>
            ))}

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
              disabled={isLoading}
            />
            <Button
              size="icon-sm"
              onClick={handleSend}
              disabled={isLoading}
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

// ── Message Bubble ────────────────────────────────────────

/**
 * Renders a single message bubble with support for:
 * - Text parts (streamed or complete)
 * - Tool parts (shows tool name + loading indicator or navigation links)
 */
function MessageBubble({ message }: { message: UIMessage }) {
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-foreground"
        }`}
      >
        {message.parts.map((part, index) => {
          // biome-ignore lint/suspicious/noArrayIndexKey: stable message parts
          const key = `${message.id}-${index}`;
          return <MessagePart key={key} part={part} />;
        })}
      </div>
    </div>
  );
}

/** Tool display labels for loading indicators */
const TOOL_LABELS: Record<string, string> = {
  queryRecords: "Querying records...",
  getRecord: "Fetching record...",
  executeAction: "Executing action...",
  describeSchema: "Loading schema info...",
  listSchemas: "Listing schemas...",
  searchSchemas: "Searching schemas...",
};

/**
 * Render a single message part based on its type.
 * AI SDK v6 uses typed parts: text, tool-{name}, dynamic-tool, reasoning, etc.
 */
// biome-ignore lint/suspicious/noExplicitAny: UIMessagePart generic is complex
function MessagePart({ part }: { part: UIMessagePart<any, any> }) {
  // Text parts
  if (part.type === "text") {
    return (
      <p className="whitespace-pre-wrap">
        {part.text}
        {part.state === "streaming" && (
          <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-foreground/50" />
        )}
      </p>
    );
  }

  // Tool parts (static: tool-{name}, dynamic: dynamic-tool)
  if (isToolUIPart(part)) {
    const toolName = getToolName(part);
    const state = part.state;

    // navigateTo tool with output — render as a clickable link
    if (toolName === "navigateTo" && state === "input-available") {
      const input = part.input as { path?: string; label?: string } | undefined;
      if (input?.path) {
        return (
          <a
            href={input.path}
            className="mt-1 flex items-center gap-1.5 rounded-md border border-primary/30 bg-background px-2 py-1 text-xs text-primary transition-colors hover:bg-primary/10"
          >
            <ExternalLinkIcon className="size-3" />
            {input.label || input.path}
          </a>
        );
      }
    }

    // In-progress tool calls — show loading indicator
    if (state === "input-streaming" || state === "input-available") {
      return (
        <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2Icon className="size-3 animate-spin" />
          <span>{TOOL_LABELS[toolName] ?? `Running ${toolName}...`}</span>
        </div>
      );
    }

    // Tool output/error — the AI will summarize results in its text response,
    // so we don't render tool outputs inline
    return null;
  }

  // Step start, reasoning, source, file parts — skip rendering
  return null;
}
