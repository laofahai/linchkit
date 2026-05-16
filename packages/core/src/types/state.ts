/**
 * State Machine type definitions
 *
 * Manages lifecycle states of business objects. Custom pure TS implementation, ~200-400 lines.
 * Transitions must be bound to Actions; direct state field modification is not allowed.
 */

import type { ErrorContext } from "./error";
import type { MetaSemantics } from "./meta-semantics";

// ── State metadata ──────────────────────────────────────

export interface StateMeta {
  label: string;
  color?: string;
  description?: string;
  /** Hide this state from the State Ribbon in list views (e.g. archived states) */
  ribbonHidden?: boolean;
}

// ── State transitions ────────────────────────────────────────

export interface Transition {
  from: string | string[];
  to: string;
  action: string;
  /** Rule name that guards this transition (Spec 67 DAG edge: state → guards → rule) */
  guard?: string;
}

// ── State Machine definition ──────────────────────────────

export interface StateDefinition<TStates extends string = string> {
  name: string;
  entity: string;
  field: string;
  initial: TStates;

  states: TStates[];
  transitions: Transition[];

  meta?: Partial<Record<TStates, StateMeta>>;
  /** Semantic metadata for AI reasoning and ontology search (Spec 67) */
  semantics?: MetaSemantics;
}

// ── State Machine extension (for Bridge) ──────────────────

export interface StateExtension {
  states?: string[];
  transitions?: Transition[];
  meta?: Record<string, StateMeta>;
}

// ── State transition result ──────────────────────────────────

export interface TransitionResult {
  allowed: boolean;
  from: string;
  to?: string;
  action?: string;
  reason?: string;
  /** AI-friendly error context for failed transitions (Spec 60 §3.4) */
  context?: ErrorContext;
}
