/**
 * Message Formatter — AIRichMessage construction and parsing.
 *
 * Rich messages embed structured blocks (action proposals, record links,
 * data tables, insights) within AI response text. The parser extracts
 * embedded JSON blocks from AI output; the formatter converts back to
 * plain text for non-rich clients.
 *
 * See spec 52 — AI Deep Integration, P2 Rich Messages.
 */

import type { RecordInsight } from "./record-analyzer";

// ── Types ───────────────────────────────────────────────────

export interface AIRichMessage {
  text: string;
  blocks?: AIMessageBlock[];
}

export type AIMessageBlock =
  | {
      type: "action_proposal";
      data: {
        action: string;
        input: Record<string, unknown>;
        confidence: number;
        explanation: string;
      };
    }
  | { type: "record_link"; data: { entity: string; id: string; label: string } }
  | {
      type: "record_list";
      data: { entity: string; records: Array<{ id: string; label: string }> };
    }
  | { type: "data_table"; data: { columns: string[]; rows: unknown[][] } }
  | { type: "insight"; data: RecordInsight }
  | { type: "navigation"; data: { url: string; label: string } };

// ── Block Tag Pattern ───────────────────────────────────────

/**
 * AI output embeds blocks using a simple tag format:
 *   <<BLOCK:type>>{ json data }<<END_BLOCK>>
 *
 * This is intentionally simple — no nested blocks.
 */
const BLOCK_REGEX = /<<BLOCK:(\w+)>>([\s\S]*?)<<END_BLOCK>>/g;

const VALID_BLOCK_TYPES = new Set([
  "action_proposal",
  "record_link",
  "record_list",
  "data_table",
  "insight",
  "navigation",
]);

// ── Parser ──────────────────────────────────────────────────

/**
 * Parse an AI output string into a rich message with embedded blocks.
 * If no block tags are found, the entire string becomes the text.
 */
export function parseRichMessage(aiOutput: string): AIRichMessage {
  const blocks: AIMessageBlock[] = [];
  let text = aiOutput;

  // Extract and remove block tags from the text
  text = text.replace(BLOCK_REGEX, (match, type: string, jsonStr: string) => {
    if (!VALID_BLOCK_TYPES.has(type)) return match; // leave unknown types as-is

    try {
      const data = JSON.parse(jsonStr.trim());
      blocks.push({ type, data } as AIMessageBlock);
      return ""; // remove block from text
    } catch {
      return match; // leave malformed blocks as-is
    }
  });

  // Clean up extra whitespace from removed blocks
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  return {
    text,
    ...(blocks.length > 0 ? { blocks } : {}),
  };
}

// ── Formatter (Plain Text Fallback) ─────────────────────────

/**
 * Convert a rich message to plain text for non-rich clients.
 */
export function formatRichMessage(message: AIRichMessage): string {
  if (!message.blocks || message.blocks.length === 0) {
    return message.text;
  }

  const parts = [message.text];

  for (const block of message.blocks) {
    switch (block.type) {
      case "action_proposal":
        parts.push(
          `\n[Action: ${block.data.action}] ${block.data.explanation} (confidence: ${Math.round(block.data.confidence * 100)}%)`,
        );
        break;

      case "record_link":
        parts.push(`\n[${block.data.entity}] ${block.data.label} (${block.data.id})`);
        break;

      case "record_list": {
        const items = block.data.records
          .map((r) => `  - ${r.label} (${r.id})`)
          .join("\n");
        parts.push(`\n[${block.data.entity} list]\n${items}`);
        break;
      }

      case "data_table": {
        const header = block.data.columns.join(" | ");
        const rows = block.data.rows
          .map((row) => row.map((cell) => String(cell ?? "")).join(" | "))
          .join("\n");
        parts.push(`\n${header}\n${rows}`);
        break;
      }

      case "insight":
        parts.push(
          `\n[${block.data.severity.toUpperCase()}] ${block.data.title}: ${block.data.description}`,
        );
        break;

      case "navigation":
        parts.push(`\n[Link] ${block.data.label}: ${block.data.url}`);
        break;
    }
  }

  return parts.filter(Boolean).join("\n");
}
