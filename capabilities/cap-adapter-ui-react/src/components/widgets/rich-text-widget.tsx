/**
 * Rich Text Widget — Tiptap-based rich text editor for text fields.
 *
 * Activated when a field has `ui: { editor: "rich" }`.
 * Stores content as HTML string.
 * Display mode renders sanitized HTML.
 * Input mode provides a toolbar with basic formatting controls.
 */

import { cn } from "@linchkit/ui-kit/lib/utils";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Strikethrough,
} from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { useSchemaLabel } from "@/i18n/use-schema-label";
import type { WidgetDisplayProps, WidgetInputProps } from "@/lib/widget-registry";
import { requiredBg } from "./utils";

// ── Display ─────────────────────────────────────────────

/** Sanitize HTML by stripping script tags and event handlers */
function sanitizeHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, "");
}

export function RichTextDisplay({ value }: WidgetDisplayProps) {
  if (value == null || value === "") {
    return <span className="text-muted-foreground leading-9">&mdash;</span>;
  }

  const html = sanitizeHtml(String(value));

  return (
    <div
      className="prose prose-sm dark:prose-invert max-w-none"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized above
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// ── Toolbar button ──────────────────────────────────────

interface ToolbarButtonProps {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}

function ToolbarButton({ onClick, active, disabled, title, children }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "inline-flex items-center justify-center rounded-sm p-1 h-7 w-7",
        "text-muted-foreground hover:text-foreground hover:bg-muted transition-colors",
        active && "bg-muted text-foreground",
        disabled && "opacity-50 cursor-not-allowed",
      )}
    >
      {children}
    </button>
  );
}

// ── Toolbar ─────────────────────────────────────────────

function EditorToolbar({ editor }: { editor: ReturnType<typeof useEditor> }) {
  const setLink = useCallback(() => {
    if (!editor) return;
    const previousUrl = editor.getAttributes("link").href;
    const url = window.prompt("URL", previousUrl);

    if (url === null) return; // cancelled
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }

    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  }, [editor]);

  const iconSize = 14;

  if (!editor) return null;

  return (
    <div className="flex items-center gap-0.5 border-b px-2 py-1 flex-wrap">
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBold().run()}
        active={editor.isActive("bold")}
        title="Bold"
      >
        <Bold size={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleItalic().run()}
        active={editor.isActive("italic")}
        title="Italic"
      >
        <Italic size={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleStrike().run()}
        active={editor.isActive("strike")}
        title="Strikethrough"
      >
        <Strikethrough size={iconSize} />
      </ToolbarButton>

      <div className="w-px h-4 bg-border mx-1" />

      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        active={editor.isActive("heading", { level: 1 })}
        title="Heading 1"
      >
        <Heading1 size={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        active={editor.isActive("heading", { level: 2 })}
        title="Heading 2"
      >
        <Heading2 size={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        active={editor.isActive("heading", { level: 3 })}
        title="Heading 3"
      >
        <Heading3 size={iconSize} />
      </ToolbarButton>

      <div className="w-px h-4 bg-border mx-1" />

      <ToolbarButton
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        active={editor.isActive("bulletList")}
        title="Bullet List"
      >
        <List size={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        active={editor.isActive("orderedList")}
        title="Ordered List"
      >
        <ListOrdered size={iconSize} />
      </ToolbarButton>

      <div className="w-px h-4 bg-border mx-1" />

      <ToolbarButton onClick={setLink} active={editor.isActive("link")} title="Link">
        <LinkIcon size={iconSize} />
      </ToolbarButton>
      <ToolbarButton
        onClick={() => editor.chain().focus().toggleCode().run()}
        active={editor.isActive("code")}
        title="Inline Code"
      >
        <Code size={iconSize} />
      </ToolbarButton>
    </div>
  );
}

// ── Input ───────────────────────────────────────────────

export function RichTextInput({
  value,
  fieldDef,
  onChange,
  onBlur,
  readonly,
  error,
  dirty,
  required,
}: WidgetInputProps) {
  const { resolveLabel } = useSchemaLabel();
  const resolvedLabel = fieldDef.label ? resolveLabel(fieldDef.label, fieldDef.label) : undefined;
  const placeholder =
    fieldDef.description ??
    (resolvedLabel ? `Enter ${resolvedLabel.toLowerCase()}` : "Start typing...");

  // Track whether external value updates should be applied
  const isInternalUpdate = useRef(false);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {
          class: "text-primary underline cursor-pointer",
        },
      }),
      Placeholder.configure({
        placeholder,
      }),
    ],
    content: value != null ? String(value) : "",
    editable: !readonly,
    onUpdate: ({ editor: ed }) => {
      isInternalUpdate.current = true;
      const html = ed.getHTML();
      // If content is just an empty paragraph, treat as empty
      onChange(html === "<p></p>" ? "" : html);
    },
    onBlur: () => {
      onBlur?.();
    },
  });

  // Sync external value changes (e.g. form reset)
  useEffect(() => {
    if (!editor) return;
    if (isInternalUpdate.current) {
      isInternalUpdate.current = false;
      return;
    }
    const currentHtml = editor.getHTML();
    const newValue = value != null ? String(value) : "";
    if (currentHtml !== newValue && !(currentHtml === "<p></p>" && newValue === "")) {
      editor.commands.setContent(newValue, { emitUpdate: false });
    }
  }, [value, editor]);

  return (
    <div className="space-y-1">
      <div
        className={cn(
          "rounded-md border bg-background",
          "focus-within:ring-1 focus-within:ring-ring focus-within:border-ring",
          required && requiredBg,
          dirty && !error && "border-ring",
          error && "border-destructive focus-within:ring-destructive",
          readonly && "opacity-60",
        )}
      >
        {!readonly && <EditorToolbar editor={editor} />}
        <EditorContent
          editor={editor}
          className={cn(
            "min-h-[150px] px-3 py-2",
            "[&_.tiptap]:outline-none [&_.tiptap]:min-h-[150px]",
            "[&_.tiptap_p.is-editor-empty:first-child::before]:text-muted-foreground",
            "[&_.tiptap_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]",
            "[&_.tiptap_p.is-editor-empty:first-child::before]:float-left",
            "[&_.tiptap_p.is-editor-empty:first-child::before]:h-0",
            "[&_.tiptap_p.is-editor-empty:first-child::before]:pointer-events-none",
            "prose prose-sm dark:prose-invert max-w-none",
          )}
        />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
