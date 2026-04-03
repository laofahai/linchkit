import { Input } from "@linchkit/ui-kit/components";
import { cn } from "@linchkit/ui-kit/lib/utils";
import { useEffect, useRef, useState } from "react";
import { useSchemaLabel } from "@/i18n/use-entity-label";
import type { WidgetDisplayProps, WidgetInputProps } from "@/lib/widget-registry";
import { requiredBg } from "./utils";

export function StringDisplay({ value }: WidgetDisplayProps) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) setOverflowing(el.scrollWidth > el.clientWidth);
  }, []);

  if (value == null) return <span className="text-muted-foreground leading-9">&mdash;</span>;

  return (
    <span className="inline-flex items-baseline gap-1 max-w-full min-w-0 leading-9">
      <span ref={ref} className={expanded ? "break-words whitespace-normal" : "truncate"}>
        {String(value)}
      </span>
      {(overflowing || expanded) && (
        <button
          type="button"
          className="shrink-0 text-xs text-primary hover:underline"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "收起" : "展开"}
        </button>
      )}
    </span>
  );
}

export function StringInput({
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
    fieldDef.description ?? (resolvedLabel ? `Enter ${resolvedLabel.toLowerCase()}` : undefined);
  return (
    <div className="space-y-1">
      <Input
        type="text"
        value={value != null ? String(value) : ""}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        disabled={readonly}
        placeholder={placeholder}
        aria-invalid={!!error}
        className={cn(
          required && requiredBg,
          dirty && !error && "border-ring",
          error && "border-destructive focus-visible:ring-destructive",
        )}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
