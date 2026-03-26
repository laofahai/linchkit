/**
 * TransitionButtons — Renders available state transition buttons for a record.
 *
 * Fetches available transitions from the GraphQL API and displays them
 * as action buttons. Clicking a button triggers the transition mutation.
 */

import type { StateDefinition, StateMeta } from "@linchkit/core/types";
import { Badge, Button } from "@linchkit/ui-kit/components";
import { ArrowRight, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type AvailableTransition,
  queryAvailableTransitions,
  transitionRecord,
} from "../lib/api";

interface TransitionButtonsProps {
  schemaName: string;
  recordId: string;
  /** Fields to return after transition (for record refresh) */
  recordFields: string[];
  /** State machine definitions for label resolution */
  states?: StateDefinition[];
  /** Callback after successful transition */
  onTransitioned?: (updatedRecord: Record<string, unknown>) => void;
}

export function TransitionButtons({
  schemaName,
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
      const result = await queryAvailableTransitions(schemaName, recordId);
      setTransitions(result);
    } catch {
      setTransitions([]);
    } finally {
      setLoading(false);
    }
  }, [schemaName, recordId]);

  useEffect(() => {
    fetchTransitions();
  }, [fetchTransitions]);

  // Resolve label for a state value from state machine meta
  function resolveStateLabel(stateValue: string): string {
    if (!states) return stateValue;
    for (const machine of states) {
      const meta: StateMeta | undefined = machine.meta?.[stateValue];
      if (meta?.label) return meta.label;
    }
    // Try i18n key
    const i18nKey = `schemas.${schemaName}.states.${stateValue}`;
    const translated = t(i18nKey, stateValue);
    return translated !== i18nKey ? translated : stateValue;
  }

  async function handleTransition(to: string) {
    setTransitioning(to);
    try {
      const updated = await transitionRecord(schemaName, recordId, to, recordFields);
      onTransitioned?.(updated as Record<string, unknown>);
      // Refresh available transitions after successful transition
      await fetchTransitions();
    } catch (err) {
      console.error("Transition failed:", err);
    } finally {
      setTransitioning(null);
    }
  }

  if (loading || transitions.length === 0) return null;

  return (
    <div className="flex items-center gap-2">
      {transitions.map((tr) => (
        <Button
          key={tr.to}
          size="sm"
          variant="outline"
          disabled={transitioning !== null}
          onClick={() => handleTransition(tr.to)}
        >
          {transitioning === tr.to ? (
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
          ) : (
            <ArrowRight className="h-3.5 w-3.5 mr-1.5" />
          )}
          <Badge variant="secondary" className="mr-1.5 text-[10px]">
            {resolveStateLabel(tr.to)}
          </Badge>
        </Button>
      ))}
    </div>
  );
}
