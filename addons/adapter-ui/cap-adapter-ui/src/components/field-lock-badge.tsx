/**
 * FieldLockBadge — Visual indicator for a locked (readonly-by-rule) field.
 *
 * Shown next to a field's label when the field is locked by an `immutable`
 * rule (edit mode) or a matching `lockWhen` / `lockAllWhen` condition
 * (Spec 63 §5.1). The tooltip explains why the field is locked.
 *
 * The icon becomes an interactive unlock toggle in two cases:
 *  - `canBypass` (Spec 63 §5.2) — the current actor may override locks. Clicking
 *    toggles the field's unlock state immediately.
 *  - `soft` (Spec 63 §4.2 SOFT_LOCK) — the field's conditional lock is advisory.
 *    Unlocking it requires an explicit TWO-STEP CONFIRMATION: clicking the toggle
 *    while the field is still locked opens a confirm dialog; confirming calls
 *    `onToggle`. (Re-locking an already-unlocked field is immediate, no dialog.)
 *
 * For a non-bypass, non-soft actor the badge renders exactly as before — a
 * static reason-aware lock icon.
 */

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@linchkit/ui-kit/components";
import type { TFunction } from "i18next";
import { Lock, LockOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FieldLockReason } from "../lib/field-lock-state";
import { ConfirmDialog } from "./confirm-dialog";

interface FieldLockBadgeProps {
  /** Why the field is locked — drives the tooltip text. */
  reason: FieldLockReason;
  /** For `locked` reason: the matched state, surfaced in the tooltip. */
  status?: string;
  /** Additional CSS class names. */
  className?: string;
  /** When true, the current actor may override locks → render an unlock toggle. */
  canBypass?: boolean;
  /**
   * When true, this field's conditional lock is a SOFT (advisory) lock. The badge
   * becomes an unlock toggle for ANY actor, but unlocking requires a two-step
   * confirmation dialog (Spec 63 §4.2).
   */
  soft?: boolean;
  /** Whether the actor has unlocked this field for editing (used when the badge is a toggle). */
  unlocked?: boolean;
  /** Toggle handler for the unlock button (used when `canBypass` or `soft`). */
  onToggle?: () => void;
}

/**
 * Resolve the tooltip text for the lock badge.
 *
 * Exported as a pure helper so the reason→text mapping is unit-testable without
 * a React render harness (this package's test setup is logic-only — no
 * jsdom/happy-dom). `soft` (and `unlocked`) select the SOFT_LOCK message when a
 * soft-locked field has not yet been confirmed for editing.
 */
export function resolveLockTooltip(
  t: TFunction,
  reason: FieldLockReason,
  status?: string,
  opts?: { soft?: boolean; unlocked?: boolean },
): string {
  // Soft lock, not yet unlocked → prompt the user that editing needs confirmation.
  if (opts?.soft && !opts.unlocked) {
    return t("form.lock.softLocked", "Locked — editing requires confirmation. Click to confirm.");
  }
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
  soft,
  unlocked,
  onToggle,
}: FieldLockBadgeProps) {
  const { t } = useTranslation();
  const [confirmOpen, setConfirmOpen] = useState(false);

  // If the field is unlocked externally (e.g. an AI suggestion or a future
  // "unlock all" action) while a stale confirm dialog state lingers, clear it —
  // otherwise a later re-lock would auto-reopen the dialog without a click.
  useEffect(() => {
    if (unlocked) setConfirmOpen(false);
  }, [unlocked]);

  // Interactive unlock toggle — bypass-eligible actor OR a soft (advisory) lock.
  if (canBypass || soft) {
    // A soft lock that is still locked needs the two-step confirmation dialog
    // before unlocking. canBypass (and the re-lock direction) toggle immediately.
    const needsConfirm = soft === true && unlocked !== true;
    const tooltip = unlocked
      ? t("form.lock.unlocked", "Unlocked — you may edit this field")
      : soft
        ? resolveLockTooltip(t, reason, status, { soft: true, unlocked: false })
        : t("form.lock.canOverride", "Locked — you may override. Click to unlock.");
    const Icon = unlocked ? LockOpen : Lock;

    return (
      <>
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
                  if (needsConfirm) {
                    // Two-step confirmation: open the dialog; onToggle fires on confirm.
                    setConfirmOpen(true);
                  } else {
                    onToggle?.();
                  }
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
        {needsConfirm && (
          <ConfirmDialog
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            variant="default"
            title={t("form.lock.confirmTitle", "Confirm editing a locked field")}
            description={t(
              "form.lock.confirmBody",
              "This field is locked in the current state. Are you sure you want to edit it?",
            )}
            confirmLabel={t("form.lock.confirmOk", "Yes, edit")}
            cancelLabel={t("form.lock.confirmCancel", "Cancel")}
            onConfirm={() => {
              setConfirmOpen(false);
              onToggle?.();
            }}
          />
        )}
      </>
    );
  }

  // Static (non-bypass, non-soft) badge — preserved byte-for-byte from the original.
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
