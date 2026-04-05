import { describe, expect, it } from "bun:test";
import { parseRichMessage, formatRichMessage } from "../src/ai/message-formatter";
import type { AIRichMessage } from "../src/ai/message-formatter";

describe("parseRichMessage", () => {
  it("returns plain text when no blocks are present", () => {
    const result = parseRichMessage("Hello, this is a plain message.");
    expect(result.text).toBe("Hello, this is a plain message.");
    expect(result.blocks).toBeUndefined();
  });

  it("extracts a record_link block", () => {
    const input = `Here is the record: <<BLOCK:record_link>>{"entity":"purchase_order","id":"po-001","label":"PO #001"}<<END_BLOCK>> check it out.`;
    const result = parseRichMessage(input);
    expect(result.text).toContain("Here is the record:");
    expect(result.text).toContain("check it out.");
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks![0].type).toBe("record_link");
    const data = result.blocks![0].data as { entity: string; id: string; label: string };
    expect(data.entity).toBe("purchase_order");
    expect(data.id).toBe("po-001");
  });

  it("extracts multiple blocks", () => {
    const input = `Found these:\n<<BLOCK:record_link>>{"entity":"order","id":"1","label":"Order 1"}<<END_BLOCK>>\n<<BLOCK:record_link>>{"entity":"order","id":"2","label":"Order 2"}<<END_BLOCK>>`;
    const result = parseRichMessage(input);
    expect(result.blocks).toHaveLength(2);
  });

  it("extracts action_proposal block", () => {
    const input = `I suggest:\n<<BLOCK:action_proposal>>{"action":"approve","input":{"id":"po-001"},"confidence":0.9,"explanation":"Ready for approval"}<<END_BLOCK>>`;
    const result = parseRichMessage(input);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks![0].type).toBe("action_proposal");
  });

  it("extracts data_table block", () => {
    const input = `<<BLOCK:data_table>>{"columns":["Name","Amount"],"rows":[["A",100],["B",200]]}<<END_BLOCK>>`;
    const result = parseRichMessage(input);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks![0].type).toBe("data_table");
  });

  it("extracts insight block", () => {
    const input = `<<BLOCK:insight>>{"type":"risk","severity":"warning","title":"High Cost","description":"Cost exceeds budget"}<<END_BLOCK>>`;
    const result = parseRichMessage(input);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks![0].type).toBe("insight");
  });

  it("extracts navigation block", () => {
    const input = `<<BLOCK:navigation>>{"url":"/schemas/order","label":"View Orders"}<<END_BLOCK>>`;
    const result = parseRichMessage(input);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks![0].type).toBe("navigation");
  });

  it("leaves unknown block types as-is in text", () => {
    const input = `Test <<BLOCK:unknown_type>>{"data":"test"}<<END_BLOCK>> end`;
    const result = parseRichMessage(input);
    expect(result.text).toContain("<<BLOCK:unknown_type>>");
    expect(result.blocks).toBeUndefined();
  });

  it("leaves malformed JSON blocks as-is in text", () => {
    const input = `Test <<BLOCK:record_link>>not valid json<<END_BLOCK>> end`;
    const result = parseRichMessage(input);
    expect(result.text).toContain("<<BLOCK:record_link>>");
    expect(result.blocks).toBeUndefined();
  });

  it("handles empty input", () => {
    const result = parseRichMessage("");
    expect(result.text).toBe("");
    expect(result.blocks).toBeUndefined();
  });
});

describe("formatRichMessage", () => {
  it("returns text only when no blocks", () => {
    const msg: AIRichMessage = { text: "Hello world" };
    expect(formatRichMessage(msg)).toBe("Hello world");
  });

  it("formats action_proposal block", () => {
    const msg: AIRichMessage = {
      text: "Suggestion:",
      blocks: [
        {
          type: "action_proposal",
          data: {
            action: "approve_order",
            input: { id: "1" },
            confidence: 0.85,
            explanation: "Order is ready",
          },
        },
      ],
    };
    const result = formatRichMessage(msg);
    expect(result).toContain("Suggestion:");
    expect(result).toContain("approve_order");
    expect(result).toContain("85%");
    expect(result).toContain("Order is ready");
  });

  it("formats record_link block", () => {
    const msg: AIRichMessage = {
      text: "Found:",
      blocks: [
        { type: "record_link", data: { entity: "order", id: "1", label: "Order #1" } },
      ],
    };
    const result = formatRichMessage(msg);
    expect(result).toContain("[order] Order #1 (1)");
  });

  it("formats record_list block", () => {
    const msg: AIRichMessage = {
      text: "",
      blocks: [
        {
          type: "record_list",
          data: {
            entity: "order",
            records: [
              { id: "1", label: "Order A" },
              { id: "2", label: "Order B" },
            ],
          },
        },
      ],
    };
    const result = formatRichMessage(msg);
    expect(result).toContain("Order A");
    expect(result).toContain("Order B");
  });

  it("formats data_table block", () => {
    const msg: AIRichMessage = {
      text: "",
      blocks: [
        {
          type: "data_table",
          data: { columns: ["Name", "Value"], rows: [["A", 1], ["B", 2]] },
        },
      ],
    };
    const result = formatRichMessage(msg);
    expect(result).toContain("Name | Value");
    expect(result).toContain("A | 1");
  });

  it("formats insight block", () => {
    const msg: AIRichMessage = {
      text: "",
      blocks: [
        {
          type: "insight",
          data: {
            type: "risk",
            severity: "critical",
            title: "Budget exceeded",
            description: "Total spending over limit",
          },
        },
      ],
    };
    const result = formatRichMessage(msg);
    expect(result).toContain("[CRITICAL]");
    expect(result).toContain("Budget exceeded");
  });

  it("formats navigation block", () => {
    const msg: AIRichMessage = {
      text: "",
      blocks: [
        { type: "navigation", data: { url: "/orders", label: "View Orders" } },
      ],
    };
    const result = formatRichMessage(msg);
    expect(result).toContain("View Orders");
    expect(result).toContain("/orders");
  });
});
