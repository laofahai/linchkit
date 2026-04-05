/**
 * TransitionButtons — Renders available state transition buttons for a record.
 *
 * Fetches available transitions from the GraphQL API and displays them
 * as action buttons. Buttons are disabled with tooltip when the actor
 * lacks permission. Clicking an allowed button triggers the transition mutation.
 */

import type { StateDefinition, StateMeta } from "@linchkit/core/types";
import {
  Badge,
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  toast,
} from "@linchkit/ui-kit/components";
import { ArrowRight, Loader2, Lock } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type AvailableTransition, queryAvailableTransitions, transitionRecord } from "../lib/api";

interface TransitionButtonsProps {
  entityName: string;
  recordId: string;
  /** Fields to return after transition (for record refresh) */
  recordFields: string[];
  /** State machine definitions for label resolution */
  states?: StateDefinition[];
  /** Callback after successful transition */
  onTransitioned?: (updatedRecord: Record<string, unknown>) => void;
}

export function TransitionButtons({
  entityName,
  recordId,
  recordFields,
  states,
  onTransitioned,
}: TransitionButtonsProps) {
  const { t } = useTranslation();
  const [transitions, setTransitions] = useState<AvailableTransition[]>([]);
  const [loading, setLoading] = useState(true);
  const [transitioning, setTransitioning] = useState<string | null>(null);

  const fetchTransitions = useCallback(async () => {
    setLoading(true);
    try {
      const result = await queryAvailableTransitions(entityName, recordId);
      setTransitions(result);
    } catch {
      setTransitions([]);
    } finally {
      setLoading(false);
    }
  }, [entityName, recordId]);

  useEffect(() => {
    fetchTransitions();
  }, [fetchTransitions]);

  // Resolve label for a state value from state machine meta, with t: prefix support
  function resolveStateLabel(stateValue: string): string {
    if (states) {
      for (const machine of states) {
        const meta: StateMeta | undefined = machine.meta?.[stateValue];
        if (meta?.label) {
          // Support t: prefix convention for i18n
          if (meta.label.startsWith("t:")) {
            const key = meta.label.slice(2);
            return t(key, { defaultValue: stateValue });
          }
          return meta.label;
        }
      }
    }
    // Try schema-specific i18n key, then common state key
    const schemaKey = `schemas.${entityName}.states.${stateValue}`;
    const schemaTranslated = t(schemaKey, { defaultValue: "" });
    if (schemaTranslated) return schemaTranslated;
    const commonKey = `states.${stateValue}`;
    const commonTranslated = t(commonKey, { defaultValue: "" });
    if (commonTranslated) return commonTranslated;
    return stateValue;
  }

  async function handleTransition(to: string) {
    setTransitioning(to);
    try {
      const updated = await transitionRecord(entityName, recordId, to, recordFields);
      toast.success(t("toast.transitionSuccess", "Status changed successfully"));
      onTransitioned?.(updated as Record<string, unknown>);
      // Refresh available transitions after successful transition
      await fetchTransitions();
    } catch (_err) {
      toast.error(t("toast.transitionFailed", "Status change failed"));
    } finally {
      setTransitioning(null);
    }
  }

  if (loading || transitions.length === 0) return null;

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex items-center gap-2">
        {transitions.map((tr) => {
          const isDisabled = !tr.allowed || transitioning !== null;
          const button = (
            <Button
              key={tr.to}
              size="sm"
              variant="outline"
              disabled={isDisabled}
              onClick={() => handleTransition(tr.to)}
            >
              {transitioning === tr.to ? (
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              ) : !tr.allowed ? (
                <Lock className="mr-1.5 size-3.5" />
              ) : (
                <ArrowRight className="mr-1.5 size-3.5" />
              )}
              <Badge variant="secondary" className="mr-1.5 text-[10px]">
                {resolveStateLabel(tr.to)}
              </Badge>
            </Button>
          );

          if (!tr.allowed && tr.reason) {
            return (
              <Tooltip key={tr.to}>
                <TooltipTrigger asChild>
                  {/* Wrap in span so tooltip works on disabled button */}
                  <span className="inline-flex">{button}</span>
                </TooltipTrigger>
                <TooltipContent>{tr.reason}</TooltipContent>
              </Tooltip>
            );
          }

          return button;
        })}
      </div>
    </TooltipProvider>
  );
}
