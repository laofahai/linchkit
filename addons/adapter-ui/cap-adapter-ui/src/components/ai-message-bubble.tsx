/**
 * AI Assistant message rendering — extracted from ai-assistant.tsx.
 *
 * Renders one `useChat` UIMessage bubble: text parts (with a streaming
 * cursor) and tool parts (loading indicator while running, a clickable link
 * for `navigateTo`). Transport-agnostic: the parts arrive from the AI SDK v6
 * state machine regardless of whether the wire is /api/ai/chat or AG-UI.
 */

import type { UIMessage, UIMessagePart } from "ai";
import { getToolName, isToolUIPart } from "ai";
import { ExternalLinkIcon, Loader2Icon } from "lucide-react";

/**
 * Renders a single message bubble with support for:
 * - Text parts (streamed or complete)
 * - Tool parts (shows tool name + loading indicator or navigation links)
 */
export function MessageBubble({ message }: { message: UIMessage }) {
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
          isUser ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
        }`}
      >
        {message.parts.map((part, index) => {
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
  listEntities: "Listing entities...",
  searchEntities: "Searching entities...",
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
