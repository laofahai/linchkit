/**
 * FieldLockBadge — Visual indicator for a locked (readonly-by-rule) field.
 *
 * Shown next to a field's label when the field is locked by an `immutable`
 * rule (edit mode) or a matching `lockWhen` / `lockAllWhen` condition
 * (Spec 63 §5.1). The tooltip explains why the field is locked.
 *
 * When the current actor may bypass locks (Spec 63 §5.2 — `canBypass`), the
 * icon becomes an interactive unlock toggle: a real `<button>` that calls
 * `onToggle`, rendering a `Lock` icon (click to unlock) or `LockOpen` icon
 * (unlocked — click to re-lock). For non-bypass actors the badge renders
 * exactly as before (a static reason-aware icon).
 */

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@linchkit/ui-kit/components";
import type { TFunction } from "i18next";
import { Lock, LockOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FieldLockReason } from "../lib/field-lock-state";

interface FieldLockBadgeProps {
  /** Why the field is locked — drives the tooltip text. */
  reason: FieldLockReason;
  /** For `locked` reason: the matched state, surfaced in the tooltip. */
  status?: string;
  /** Additional CSS class names. */
  className?: string;
  /** When true, the current actor may override locks → render an unlock toggle. */
  canBypass?: boolean;
  /** When `canBypass`, whether the actor has unlocked this field for editing. */
  unlocked?: boolean;
  /** Toggle handler for the unlock button (only used when `canBypass`). */
  onToggle?: () => void;
}

/**
 * Resolve the tooltip text for the static (non-bypass) lock badge.
 *
 * Exported as a pure helper so the reason→text mapping is unit-testable without
 * a React render harness (this package's test setup is logic-only — no
 * jsdom/happy-dom).
 */
export function resolveLockTooltip(t: TFunction, reason: FieldLockReason, status?: string): string {
  if (reason === "immutable") {
    return t("form.lock.immutable", "This field cannot be changed after creation");
  }
  if (status) {
    return t("form.lock.lockedInState", {
      defaultValue: 'Locked because the record is in state "{{status}}"',
      status,
    });
  }
  return t("form.lock.locked", "This field is locked in the current state");
}

/** Shared icon CSS — keeps the bypass toggle visually identical to the static badge. */
const ICON_CLASS = "size-3 text-muted-foreground/60 shrink-0";

/** Renders a small lock icon badge with a reason-aware tooltip on locked fields. */
export function FieldLockBadge({
  reason,
  status,
  className,
  canBypass,
  unlocked,
  onToggle,
}: FieldLockBadgeProps) {
  const { t } = useTranslation();

  // Bypass-eligible actor → interactive unlock toggle.
  if (canBypass) {
    const tooltip = unlocked
      ? t("form.lock.unlocked", "Unlocked — you may edit this field")
      : t("form.lock.canOverride", "Locked — you may override. Click to unlock.");
    const Icon = unlocked ? LockOpen : Lock;
    return (
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              // The badge renders inside the field's <Label> (an HTML <label>),
              // so a bare click would bubble up and trigger the label's default
              // behavior (focusing / activating the associated input). Prevent
              // and stop it so the toggle only flips the unlock state.
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onToggle?.();
              }}
              className={`inline-flex items-center ${className ?? ""}`}
              aria-label={t("form.lock.toggleAriaLabel", "Toggle field lock")}
              aria-pressed={unlocked === true}
            >
              <Icon className={ICON_CLASS} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            {tooltip}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  // Static (non-bypass) badge — preserved byte-for-byte from the original.
  const tooltip = resolveLockTooltip(t, reason, status);

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Lock
            className={`${ICON_CLASS} ${className ?? ""}`}
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
