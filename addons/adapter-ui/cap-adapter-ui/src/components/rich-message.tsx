/**
 * RichMessage — Renders AIRichMessage with embedded blocks.
 *
 * Supports rendering: record_link, record_list, data_table, insight,
 * action_proposal, and navigation blocks within AI response text.
 *
 * See spec 52 — AI Deep Integration, P2 Rich Messages.
 */

import { Badge } from "@linchkit/ui-kit/components";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangleIcon,
  ExternalLinkIcon,
  InfoIcon,
  LinkIcon,
  ShieldAlertIcon,
} from "lucide-react";
import { ActionProposalCard, type ActionProposalCardProps } from "./action-proposal-card";

// ── Types (mirrors core AIMessageBlock) ─────────────────────

interface ActionProposalBlock {
  type: "action_proposal";
  data: {
    action: string;
    input: Record<string, unknown>;
    confidence: number;
    explanation: string;
  };
}

interface RecordLinkBlock {
  type: "record_link";
  data: { entity: string; id: string; label: string };
}

interface RecordListBlock {
  type: "record_list";
  data: { entity: string; records: Array<{ id: string; label: string }> };
}

interface DataTableBlock {
  type: "data_table";
  data: { columns: string[]; rows: unknown[][] };
}

interface InsightBlock {
  type: "insight";
  data: {
    type: string;
    severity: "info" | "warning" | "critical";
    title: string;
    description: string;
  };
}

interface NavigationBlock {
  type: "navigation";
  data: { url: string; label: string };
}

type AIMessageBlock =
  | ActionProposalBlock
  | RecordLinkBlock
  | RecordListBlock
  | DataTableBlock
  | InsightBlock
  | NavigationBlock;

export interface AIRichMessage {
  text: string;
  blocks?: AIMessageBlock[];
}

// ── Props ───────────────────────────────────────────────────

export interface RichMessageProps {
  message: AIRichMessage;
  onActionComplete?: ActionProposalCardProps["onComplete"];
}

// ── Block Renderers ─────────────��───────────────────────────

function RecordLinkRenderer({ block }: { block: RecordLinkBlock }) {
  return (
    <Link
      to={"/entities/$name/$id" as "/"}
      params={{ name: block.data.entity, id: block.data.id }}
      className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs text-primary hover:bg-accent transition-colors"
    >
      <LinkIcon className="size-3" />
      {block.data.label}
    </Link>
  );
}

function RecordListRenderer({ block }: { block: RecordListBlock }) {
  return (
    <div className="my-1.5 rounded-md border p-2">
      <div className="text-[11px] font-medium text-muted-foreground mb-1.5">
        {block.data.entity}
      </div>
      <div className="space-y-1">
        {block.data.records.map((rec) => (
          <Link
            key={rec.id}
            to={"/entities/$name/$id" as "/"}
            params={{ name: block.data.entity, id: rec.id }}
            className="flex items-center gap-1.5 text-xs text-primary hover:underline"
          >
            <LinkIcon className="size-3 shrink-0" />
            {rec.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

function DataTableRenderer({ block }: { block: DataTableBlock }) {
  return (
    <div className="my-1.5 overflow-x-auto rounded-md border">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b bg-muted/50">
            {block.data.columns.map((col) => (
              <th key={col} className="px-2 py-1.5 text-left font-medium text-muted-foreground">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.data.rows.map((row, rowIdx) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: table rows have no stable ID
            <tr key={`row-${rowIdx}`} className="border-b last:border-0">
              {row.map((cell, cellIdx) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: table cells have no stable ID
                <td key={`cell-${cellIdx}`} className="px-2 py-1.5">
                  {String(cell ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InsightRenderer({ block }: { block: InsightBlock }) {
  const severityIcon =
    block.data.severity === "critical" ? (
      <ShieldAlertIcon className="size-3.5 text-red-500" />
    ) : block.data.severity === "warning" ? (
      <AlertTriangleIcon className="size-3.5 text-amber-500" />
    ) : (
      <InfoIcon className="size-3.5 text-blue-500" />
    );

  const severityVariant =
    block.data.severity === "critical"
      ? "destructive"
      : block.data.severity === "warning"
        ? "default"
        : "secondary";

  return (
    <div className="my-1.5 flex items-start gap-2 rounded-md border p-2.5">
      {severityIcon}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium">{block.data.title}</span>
          <Badge variant={severityVariant} className="text-[9px] px-1 py-0">
            {block.data.severity}
          </Badge>
        </div>
        <p className="text-[11px] text-muted-foreground mt-0.5">{block.data.description}</p>
      </div>
    </div>
  );
}

function NavigationRenderer({ block }: { block: NavigationBlock }) {
  const isExternal = block.data.url.startsWith("http");

  if (isExternal) {
    return (
      <a
        href={block.data.url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
      >
        <ExternalLinkIcon className="size-3" />
        {block.data.label}
      </a>
    );
  }

  return (
    <Link
      to={block.data.url as "/"}
      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
    >
      <ExternalLinkIcon className="size-3" />
      {block.data.label}
    </Link>
  );
}

function ActionProposalRenderer({
  block,
  onComplete,
}: {
  block: ActionProposalBlock;
  onComplete?: ActionProposalCardProps["onComplete"];
}) {
  // Convert to IntentResolution shape expected by ActionProposalCard
  const intent = {
    action: block.data.action,
    schema: "",
    input: block.data.input,
    missingFields: [] as string[],
    confidence: block.data.confidence,
    explanation: block.data.explanation,
    actionLabel: block.data.action,
    inputSchema: {} as Record<string, never>,
  };

  return (
    <div className="my-1.5">
      <ActionProposalCard intent={intent} onComplete={onComplete} />
    </div>
  );
}

// ── Main Component ─��────────────────────────────────────────

export function RichMessage({ message, onActionComplete }: RichMessageProps) {
  return (
    <div className="space-y-1">
      {/* Text content */}
      {message.text && (
        <div className="text-sm whitespace-pre-wrap leading-relaxed">{message.text}</div>
      )}

      {/* Embedded blocks */}
      {message.blocks?.map((block, idx) => {
        const key = `${block.type}-${idx}`;
        switch (block.type) {
          case "record_link":
            return <RecordLinkRenderer key={key} block={block} />;
          case "record_list":
            return <RecordListRenderer key={key} block={block} />;
          case "data_table":
            return <DataTableRenderer key={key} block={block} />;
          case "insight":
            return <InsightRenderer key={key} block={block} />;
          case "navigation":
            return <NavigationRenderer key={key} block={block} />;
          case "action_proposal":
            return <ActionProposalRenderer key={key} block={block} onComplete={onActionComplete} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
