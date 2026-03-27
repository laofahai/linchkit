import { Textarea } from "@linchkit/ui-kit/components";
import { cn } from "@linchkit/ui-kit/lib/utils";
import { useEffect, useRef, useState } from "react";
import type { WidgetDisplayProps, WidgetInputProps } from "@/lib/widget-registry";
import { requiredBg } from "./utils";

export function TextDisplay({ value }: WidgetDisplayProps) {
  if (value == null) return <span className="text-muted-foreground leading-9">&mdash;</span>;
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el) setClamped(el.scrollHeight > el.clientHeight);
  }, [value]);

  return (
    <div>
      <div
        ref={ref}
        className={cn("whitespace-pre-wrap", !expanded && "line-clamp-3")}
      >
        {String(value)}
      </div>
      {(clamped || expanded) && (
        <button
          type="button"
          className="text-xs text-primary hover:underline mt-1"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? "收起" : "展开"}
        </button>
      )}
    </div>
  );
}

export function TextInput({
  value,
  fieldDef,
  onChange,
  onBlur,
  readonly,
  error,
  dirty,
  required,
}: WidgetInputProps) {
  const placeholder =
    fieldDef.description ?? (fieldDef.label ? `Enter ${fieldDef.label.toLowerCase()}` : undefined);
  return (
    <div className="space-y-1">
      <Textarea
        value={value != null ? String(value) : ""}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        disabled={readonly}
        placeholder={placeholder}
        aria-invalid={!!error}
        className={cn(required && requiredBg, dirty && !error && "border-ring", error && "border-destructive focus-visible:ring-destructive")}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
