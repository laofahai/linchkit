/**
 * ChatterPanel — Unified record timeline replacing ActivityPanel.
 *
 * Displays a chronological timeline of:
 * - User comments and notes (posted via MessageComposer)
 * - Auto-generated log entries (field changes, state transitions, CRUD events)
 *
 * Connects to @linchkit/cap-chatter via GraphQL.
 * Falls back gracefully when cap-chatter is not installed (shows empty state).
 */

import { Badge, Button, Textarea } from "@linchkit/ui-kit/components";
import {
  ArrowRight,
  Edit,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Send,
  StickyNote,
  Trash2,
  User,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSubscription } from "../hooks/use-subscription";
import { addChatterMessage, type ChatterMessage, queryChatterMessages } from "../lib/api";

interface ChatterPanelProps {
  schemaName: string;
  recordId: string;
}

// ── Time formatting ───────────────────────────────────────

type TFunc = ReturnType<typeof useTranslation>["t"];

function formatRelativeTime(iso: string, t: TFunc): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return t("time.justNow", { defaultValue: "just now" });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("time.minutesAgo", { defaultValue: "{{count}}m ago", count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("time.hoursAgo", { defaultValue: "{{count}}h ago", count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t("time.daysAgo", { defaultValue: "{{count}}d ago", count: days });
  return new Date(iso).toLocaleDateString();
}

// ── Log entry metadata rendering ──────────────────────────

interface LogMetaChangedFields {
  changed_fields?: string[];
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

interface LogMetaStateTransition {
  from?: string;
  to?: string;
  action?: string;
}

function renderLogDetail(msg: ChatterMessage): React.ReactNode {
  if (!msg.logEvent || !msg.logMetadata) return null;

  if (msg.logEvent === "record.updated") {
    const meta = msg.logMetadata as LogMetaChangedFields;
    const fields = meta.changed_fields ?? [];
    if (fields.length === 0) return null;
    return (
      <div className="mt-2 rounded border border-border/40 bg-muted/30 overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border/40 bg-muted/50">
              <th className="text-left px-2.5 py-1.5 font-medium text-muted-foreground">Field</th>
              <th className="text-left px-2.5 py-1.5 font-medium text-muted-foreground">Before</th>
              <th className="text-left px-2.5 py-1.5 font-medium text-muted-foreground">After</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((field) => (
              <tr key={field} className="border-b border-border/30 last:border-0">
                <td className="px-2.5 py-1.5 font-mono text-muted-foreground">{field}</td>
                <td className="px-2.5 py-1.5 text-muted-foreground/70">
                  {String(meta.before?.[field] ?? "—")}
                </td>
                <td className="px-2.5 py-1.5 font-medium">{String(meta.after?.[field] ?? "—")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (msg.logEvent === "state.transition") {
    const meta = msg.logMetadata as LogMetaStateTransition;
    if (!meta.from || !meta.to) return null;
    return (
      <div className="mt-1.5 flex items-center gap-1.5">
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-muted/50 font-normal">
          {meta.from}
        </Badge>
        <ArrowRight className="size-3 text-muted-foreground" />
        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-normal">
          {meta.to}
        </Badge>
      </div>
    );
  }

  return null;
}

// ── Log icon config ───────────────────────────────────────

function getLogIcon(logEvent?: string | null) {
  if (logEvent === "record.created")
    return {
      Icon: Plus,
      dot: "bg-green-100 dark:bg-green-950 border-green-300 dark:border-green-700",
      color: "text-green-600 dark:text-green-400",
    };
  if (logEvent === "record.deleted")
    return {
      Icon: Trash2,
      dot: "bg-red-100 dark:bg-red-950 border-red-300 dark:border-red-700",
      color: "text-red-600 dark:text-red-400",
    };
  if (logEvent === "state.transition")
    return {
      Icon: Zap,
      dot: "bg-amber-100 dark:bg-amber-950 border-amber-300 dark:border-amber-700",
      color: "text-amber-600 dark:text-amber-400",
    };
  return {
    Icon: Edit,
    dot: "bg-blue-100 dark:bg-blue-950 border-blue-300 dark:border-blue-700",
    color: "text-blue-600 dark:text-blue-400",
  };
}

// ── Timeline item components ──────────────────────────────

interface TimelineItemProps {
  message: ChatterMessage;
  isLast: boolean;
}

function LogTimelineItem({ message, isLast }: TimelineItemProps) {
  const { t } = useTranslation();
  const { Icon, dot, color } = getLogIcon(message.logEvent);
  const detail = renderLogDetail(message);

  return (
    <div className="relative flex gap-3 pb-4 last:pb-0">
      {!isLast && <div className="absolute left-[15px] top-8 bottom-0 w-px bg-border" />}
      <div
        className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${dot}`}
      >
        <Icon className={`size-3.5 ${color}`} />
      </div>
      <div className="flex-1 min-w-0 pt-0.5">
        <p className={`text-sm ${color} font-medium`}>{message.body}</p>
        {detail}
        <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground">
          <User className="size-3" />
          <span>{message.author.name ?? message.author.id}</span>
          <span className="text-border">·</span>
          <span title={new Date(message.createdAt).toLocaleString()}>
            {formatRelativeTime(message.createdAt, t)}
          </span>
        </div>
      </div>
    </div>
  );
}

function CommentTimelineItem({ message, isLast }: TimelineItemProps) {
  const { t } = useTranslation();
  const isNote = message.messageType === "note";

  return (
    <div className="relative flex gap-3 pb-4 last:pb-0">
      {!isLast && <div className="absolute left-[15px] top-8 bottom-0 w-px bg-border" />}
      {/* Avatar dot */}
      <div
        className={`relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border ${
          isNote
            ? "bg-purple-100 dark:bg-purple-950 border-purple-300 dark:border-purple-700"
            : "bg-muted border-border"
        }`}
      >
        {isNote ? (
          <StickyNote className="size-3.5 text-purple-600 dark:text-purple-400" />
        ) : (
          <MessageSquare className="size-3.5 text-muted-foreground" />
        )}
      </div>
      <div className="flex-1 min-w-0 pt-0.5">
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-sm font-medium">{message.author.name ?? message.author.id}</span>
          {isNote && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              {t("chatter.note", "Note")}
            </Badge>
          )}
          <span
            className="text-xs text-muted-foreground"
            title={new Date(message.createdAt).toLocaleString()}
          >
            {formatRelativeTime(message.createdAt, t)}
          </span>
        </div>
        <div className="rounded-md border border-border/50 bg-background px-3 py-2 text-sm whitespace-pre-wrap">
          {message.body}
        </div>
      </div>
    </div>
  );
}

// ── Message Composer ──────────────────────────────────────

interface MessageComposerProps {
  schemaName: string;
  recordId: string;
  onSent: (message: ChatterMessage) => void;
}

function MessageComposer({ schemaName, recordId, onSent }: MessageComposerProps) {
  const { t } = useTranslation();
  const [body, setBody] = useState("");
  const [messageType, setMessageType] = useState<"comment" | "note">("comment");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  async function handleSend() {
    const trimmed = body.trim();
    if (!trimmed || sending) return;
    setSending(true);
    try {
      const msg = await addChatterMessage(schemaName, recordId, messageType, trimmed);
      setBody("");
      onSent(msg);
      textareaRef.current?.focus();
    } catch {
      // Silently fail — user can retry
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="border-t border-border/50 pt-3 mt-3">
      {/* Type toggle */}
      <div className="flex gap-1 mb-2">
        <button
          type="button"
          onClick={() => setMessageType("comment")}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            messageType === "comment"
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:bg-muted/80"
          }`}
        >
          <MessageSquare className="size-3" />
          {t("chatter.comment", "Comment")}
        </button>
        <button
          type="button"
          onClick={() => setMessageType("note")}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
            messageType === "note"
              ? "bg-purple-600 text-white"
              : "bg-muted text-muted-foreground hover:bg-muted/80"
          }`}
        >
          <StickyNote className="size-3" />
          {t("chatter.note", "Note")}
        </button>
      </div>

      <div className="flex gap-2 items-end">
        <Textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            messageType === "note"
              ? t("chatter.notePlaceholder", "Add an internal note… (Ctrl+Enter to send)")
              : t("chatter.commentPlaceholder", "Write a comment… (Ctrl+Enter to send)")
          }
          className="flex-1 min-h-[72px] resize-none text-sm"
          disabled={sending}
        />
        <Button
          size="sm"
          onClick={handleSend}
          disabled={!body.trim() || sending}
          className="shrink-0 self-end"
        >
          {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
        </Button>
      </div>
    </div>
  );
}

// ── Subscription query ────────────────────────────────────

const CHATTER_SUBSCRIPTION = `
  subscription OnChatterMessage($schemaName: String!, $recordId: String!) {
    onChatterMessage(schemaName: $schemaName, recordId: $recordId) {
      id schemaName recordId messageType body
      author { id type name }
      logEvent logMetadata
      createdAt updatedAt
    }
  }
`;

// ── Main Panel ────────────────────────────────────────────

const MAX_SCROLL_HEIGHT = 480;

export function ChatterPanel({ schemaName, recordId }: ChatterPanelProps) {
  const { t } = useTranslation();
  const [messages, setMessages] = useState<ChatterMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const fetchMessages = useCallback(async () => {
    setLoading(true);
    try {
      const result = await queryChatterMessages(schemaName, recordId);
      setMessages(result.items);
    } catch {
      setMessages([]);
    } finally {
      setLoading(false);
    }
  }, [schemaName, recordId]);

  useEffect(() => {
    fetchMessages();
  }, [fetchMessages]);

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  // Real-time subscription
  useSubscription({
    query: CHATTER_SUBSCRIPTION,
    variables: { schemaName, recordId },
    enabled: !!schemaName && !!recordId,
    onData: (data) => {
      const newMsg = (data as { onChatterMessage?: ChatterMessage }).onChatterMessage;
      if (newMsg) {
        setMessages((prev) => {
          // Deduplicate by id
          if (prev.some((m) => m.id === newMsg.id)) return prev;
          return [...prev, newMsg];
        });
      }
    },
  });

  function handleSent(msg: ChatterMessage) {
    setMessages((prev) => {
      if (prev.some((m) => m.id === msg.id)) return prev;
      return [...prev, msg];
    });
  }

  return (
    <div className="bg-background rounded shadow-sm border border-border/50 px-4 py-4 md:px-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-muted-foreground">
          {t("chatter.title", "Chatter")}
        </h2>
        <Button variant="ghost" size="sm" onClick={fetchMessages} disabled={loading}>
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* Timeline */}
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : messages.length === 0 ? (
        <div className="py-6 text-center text-sm text-muted-foreground">
          {t("chatter.noMessages", "No messages yet. Be the first to comment!")}
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="overflow-y-auto pr-1"
          style={{ maxHeight: `${MAX_SCROLL_HEIGHT}px` }}
        >
          {messages.map((msg, idx) => {
            const isLast = idx === messages.length - 1;
            if (msg.messageType === "log") {
              return <LogTimelineItem key={msg.id} message={msg} isLast={isLast} />;
            }
            return <CommentTimelineItem key={msg.id} message={msg} isLast={isLast} />;
          })}
        </div>
      )}

      {/* Message composer */}
      <MessageComposer schemaName={schemaName} recordId={recordId} onSent={handleSent} />
    </div>
  );
}
