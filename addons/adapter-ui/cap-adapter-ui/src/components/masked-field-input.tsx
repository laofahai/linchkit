/**
 * MaskedFieldInput — Click-to-unlock editing for sensitive masked fields.
 *
 * In edit mode, masked fields display the masked value with a lock icon.
 * Clicking the lock unlocks the field for editing with a fresh empty input.
 * If the user leaves it blank and blurs, it reverts to the masked state.
 * When unlocked with a new value, the form submit handler includes it normally.
 */

import type { FieldDefinition, ViewFieldConfig } from "@linchkit/core/types";
import {
  Button,
  Input,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@linchkit/ui-kit/components";
import { LockIcon, UnlockIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MaskedValue } from "./masked-value";

interface MaskedFieldInputProps {
  /** The original masked value from the server */
  maskedValue: string;
  /** The field definition */
  fieldDef: FieldDefinition;
  /** The view field config */
  field: ViewFieldConfig;
  /** Called when the value changes */
  onChange: (value: unknown) => void;
  /** Called on blur */
  onBlur?: () => void;
  /** Error message */
  error?: string;
}

export function MaskedFieldInput({
  maskedValue,
  fieldDef: _fieldDef,
  field: _field,
  onChange,
  onBlur,
  error,
}: MaskedFieldInputProps) {
  const { t } = useTranslation();
  const [unlocked, setUnlocked] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleUnlock = useCallback(() => {
    setUnlocked(true);
    setInputValue("");
    // Clear the form value so it no longer holds the masked placeholder
    onChange("");
    // Focus the input after React re-renders
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, [onChange]);

  const handleLock = useCallback(() => {
    setUnlocked(false);
    setInputValue("");
    // Restore the masked value so the submit handler will strip it
    onChange(maskedValue);
  }, [maskedValue, onChange]);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value;
      setInputValue(v);
      onChange(v);
    },
    [onChange],
  );

  const handleBlur = useCallback(() => {
    // If the user left the field empty, revert to masked (locked) state
    if (inputValue.trim() === "") {
      handleLock();
    }
    onBlur?.();
  }, [inputValue, handleLock, onBlur]);

  // Locked state: show masked value with unlock button
  if (!unlocked) {
    return (
      <div className="flex items-center gap-2">
        <MaskedValue value={maskedValue} className="flex-1" />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              onClick={handleUnlock}
            >
              <LockIcon className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("masking.clickToEdit")}</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  // Unlocked state: editable input with lock button to revert
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={handleInputChange}
          onBlur={handleBlur}
          placeholder={t("masking.newValuePlaceholder")}
          aria-invalid={!!error}
          className={`flex-1 ${error ? "border-destructive focus-visible:ring-destructive" : ""}`}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              onClick={handleLock}
            >
              <UnlockIcon className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("masking.cancelEdit")}</TooltipContent>
        </Tooltip>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
