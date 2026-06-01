/**
 * FieldLockBadge — Visual indicator for a locked (readonly-by-rule) field.
 *
 * Shown next to a field's label when the field is locked by an `immutable`
 * rule (edit mode) or a matching `lockWhen` / `lockAllWhen` condition
 * (Spec 63 §5.1). The tooltip explains why the field is locked.
 */

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@linchkit/ui-kit/components";
import { Lock } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FieldLockReason } from "../lib/field-lock-state";

interface FieldLockBadgeProps {
  /** Why the field is locked — drives the tooltip text. */
  reason: FieldLockReason;
  /** For `locked` reason: the matched state, surfaced in the tooltip. */
  status?: string;
  /** Additional CSS class names. */
  className?: string;
}

/** Renders a small lock icon badge with a reason-aware tooltip on locked fields. */
export function FieldLockBadge({ reason, status, className }: FieldLockBadgeProps) {
  const { t } = useTranslation();

  const tooltip =
    reason === "immutable"
      ? t("form.lock.immutable", "This field cannot be changed after creation")
      : status
        ? t("form.lock.lockedInState", {
            defaultValue: 'Locked because the record is in state "{{status}}"',
            status,
          })
        : t("form.lock.locked", "This field is locked in the current state");

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Lock
            className={`size-3 text-muted-foreground/60 shrink-0 ${className ?? ""}`}
            aria-label={t("form.lock.ariaLabel", "Locked field")}
          />
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
