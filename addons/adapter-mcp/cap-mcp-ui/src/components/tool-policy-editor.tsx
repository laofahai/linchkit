/**
 * ToolPolicyEditor — Visual editor for MCP tool access policies.
 *
 * Supports three modes:
 * - allow_all: All tools are accessible
 * - categories: Toggle tool categories on/off
 * - allowlist/denylist: Custom list of specific tool names
 */

import { Badge, Button, Input, Label, Switch } from "@linchkit/ui-kit/components";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ToolPolicy } from "../lib/api";

// ── Known tool categories ──────────────────────────────

const TOOL_CATEGORIES = [
  "introspection",
  "query",
  "actions",
  "ai_security",
  "scaffold",
  "ontology",
  "docs",
  "management",
] as const;

type ToolCategory = (typeof TOOL_CATEGORIES)[number];

// ── Props ──────────────────────────────────────────────

interface ToolPolicyEditorProps {
  value: ToolPolicy;
  onChange: (policy: ToolPolicy) => void;
}

// ── Component ──────────────────────────────────────────

export function ToolPolicyEditor({ value, onChange }: ToolPolicyEditorProps) {
  const { t } = useTranslation();
  const [newTool, setNewTool] = useState("");

  const mode = value.mode;

  // ── Mode selector ──────────────────────────────────

  const setMode = (newMode: ToolPolicy["mode"]) => {
    if (newMode === "allow_all") {
      onChange({ mode: "allow_all" });
    } else if (newMode === "categories") {
      onChange({ mode: "categories", categories: [...TOOL_CATEGORIES] });
    } else {
      onChange({ mode: newMode, tools: value.tools ?? [] });
    }
  };

  // ── Category toggle ────────────────────────────────

  const toggleCategory = (category: ToolCategory) => {
    const current = value.categories ?? [];
    const next = current.includes(category)
      ? current.filter((c) => c !== category)
      : [...current, category];
    onChange({ ...value, categories: next });
  };

  // ── Tool name management ───────────────────────────

  const addTool = () => {
    const name = newTool.trim();
    if (!name) return;
    const tools = value.tools ?? [];
    if (tools.includes(name)) return;
    onChange({ ...value, tools: [...tools, name] });
    setNewTool("");
  };

  const removeTool = (name: string) => {
    const tools = (value.tools ?? []).filter((t) => t !== name);
    onChange({ ...value, tools });
  };

  return (
    <div className="space-y-4">
      <Label className="text-sm font-medium">{t("mcp.admin.toolPolicy.title")}</Label>

      {/* Mode selector */}
      <div className="flex gap-2">
        {(
          [
            ["allow_all", t("mcp.admin.toolPolicy.allowAll")],
            ["categories", t("mcp.admin.toolPolicy.categories")],
            ["allowlist", t("mcp.admin.toolPolicy.allowlist")],
            ["denylist", t("mcp.admin.toolPolicy.denylist")],
          ] as const
        ).map(([m, label]) => (
          <Button
            key={m}
            variant={mode === m ? "default" : "outline"}
            size="sm"
            onClick={() => setMode(m)}
          >
            {label}
          </Button>
        ))}
      </div>

      {/* Categories mode */}
      {mode === "categories" && (
        <div className="grid grid-cols-2 gap-3">
          {TOOL_CATEGORIES.map((category) => {
            const enabled = (value.categories ?? []).includes(category);
            return (
              <div key={category} className="flex items-center justify-between">
                <Label className="text-sm">{t(`mcp.admin.toolPolicy.${category}`)}</Label>
                <Switch checked={enabled} onCheckedChange={() => toggleCategory(category)} />
              </div>
            );
          })}
        </div>
      )}

      {/* Custom mode (allowlist/denylist) */}
      {(mode === "allowlist" || mode === "denylist") && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Input
              value={newTool}
              onChange={(e) => setNewTool(e.target.value)}
              placeholder={t("mcp.admin.toolPolicy.addTool")}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTool();
                }
              }}
            />
            <Button variant="outline" size="sm" onClick={addTool} disabled={!newTool.trim()}>
              <PlusIcon className="size-4" />
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {(value.tools ?? []).map((tool) => (
              <Badge key={tool} variant="secondary" className="gap-1">
                <code className="text-xs">{tool}</code>
                <button
                  type="button"
                  className="ml-1 hover:text-destructive"
                  onClick={() => removeTool(tool)}
                >
                  <XIcon className="size-3" />
                </button>
              </Badge>
            ))}
            {(value.tools ?? []).length === 0 && (
              <p className="text-sm text-muted-foreground">
                {mode === "allowlist"
                  ? "No tools allowed — add tool names above"
                  : "No tools denied — all tools accessible"}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default ToolPolicyEditor;
