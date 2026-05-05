/**
 * OnchangeDispatcher — Framework-agnostic dispatcher for Spec 64 entity onchange.
 *
 * Encapsulates the debounce + sequence-number race protection so it can be
 * tested without React. The React `useEntityOnchange` hook is a thin wrapper
 * that wires this dispatcher to component state.
 *
 * Race protection: every dispatched call is tagged with a monotonically
 * increasing sequence number. When a response arrives, the dispatcher checks
 * the current sequence — older responses are dropped (`onUpdates` is not
 * invoked). An AbortController is also signaled on supersession so the network
 * request can be cut short by `requestEntityOnchange`.
 */

import type { OnchangeDefinition } from "@linchkit/core/types";
import type { EntityOnchangeResult } from "./api";

/** Default debounce — Spec 64 §6.1 mandates a 300ms minimum between calls. */
export const DEFAULT_ONCHANGE_DEBOUNCE_MS = 300;

export type OnchangeFetcher = (params: {
  entity: string;
  changedField: string;
  values: Record<string, unknown>;
  signal?: AbortSignal;
}) => Promise<EntityOnchangeResult>;

export interface OnchangeDispatcherOptions {
  /** Entity name (`schema.name`). */
  entity: string;
  /** Onchange map from the entity definition. */
  onchange: Record<string, OnchangeDefinition> | undefined;
  /** Snapshot the current form values at call time. */
  getValues: () => Record<string, unknown>;
  /** Apply server-returned `updates`. Only invoked for the LATEST request. */
  onUpdates: (updates: Record<string, unknown>) => void;
  /** Optional non-blocking warnings handler. Only invoked for the latest request. */
  onWarnings?: (warnings: string[]) => void;
  /** Optional in-flight notifications — used by the React hook to drive a spinner. */
  onLoadingChange?: (loading: boolean, pendingFields: ReadonlySet<string>) => void;
  /** Network helper. Real callers leave this default; tests inject a mock. */
  fetcher: OnchangeFetcher;
  /** Debounce override. Defaults to {@link DEFAULT_ONCHANGE_DEBOUNCE_MS}. */
  debounceMs?: number;
}

/**
 * Build a `triggerField -> updates[]` index from the entity's onchange map.
 *
 * Comma-separated keys (`"quantity,unit_price"`) explode so each individual
 * field maps to the same updates list. Pure function — exported for tests.
 */
export function buildOnchangeIndex(
  onchange: Record<string, OnchangeDefinition> | undefined,
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  if (!onchange) return index;
  for (const [key, def] of Object.entries(onchange)) {
    const triggers = key
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const trigger of triggers) {
      const existing = index.get(trigger);
      if (existing) {
        for (const u of def.updates) if (!existing.includes(u)) existing.push(u);
      } else {
        index.set(trigger, [...def.updates]);
      }
    }
  }
  return index;
}

interface InFlight {
  seq: number;
  controller: AbortController;
}

export class OnchangeDispatcher {
  private readonly options: OnchangeDispatcherOptions;
  private index: Map<string, string[]>;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingField: string | null = null;
  private seq = 0;
  private lastAppliedSeq = 0;
  private inFlight: InFlight | null = null;

  constructor(options: OnchangeDispatcherOptions) {
    this.options = options;
    this.index = buildOnchangeIndex(options.onchange);
  }

  /** Re-index when the entity's onchange map changes (e.g. capability hot-reload). */
  setOnchange(onchange: Record<string, OnchangeDefinition> | undefined): void {
    this.index = buildOnchangeIndex(onchange);
  }

  /** Schedule an onchange call for the given field. No-op when no hook matches.
   *  Note: warning-only hooks (`updates: []`) are dispatched too — the
   *  decision is whether a hook exists for the trigger, NOT whether it
   *  declares writable fields. */
  trigger(changedField: string): void {
    if (!this.index.has(changedField)) return;
    this.pendingField = changedField;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    const ms = Math.max(0, this.options.debounceMs ?? DEFAULT_ONCHANGE_DEBOUNCE_MS);
    this.debounceTimer = setTimeout(() => this.flush(), ms);
  }

  /** Cancel any pending or in-flight work. */
  cancel(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingField = null;
    if (this.inFlight) {
      this.inFlight.controller.abort();
      this.inFlight = null;
    }
    this.options.onLoadingChange?.(false, new Set());
  }

  /** Force the pending request to fire immediately. Test helper. */
  flushNow(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.flush();
  }

  private flush(): void {
    this.debounceTimer = null;
    const field = this.pendingField;
    this.pendingField = null;
    if (!field) return;

    if (this.inFlight) this.inFlight.controller.abort();

    const seq = ++this.seq;
    const controller = new AbortController();
    this.inFlight = { seq, controller };
    const pendingFields = new Set(this.index.get(field) ?? []);
    this.options.onLoadingChange?.(true, pendingFields);

    const values = { ...this.options.getValues() };

    this.options
      .fetcher({
        entity: this.options.entity,
        changedField: field,
        values,
        signal: controller.signal,
      })
      .then((result) => {
        // Drop stale responses — a newer call has overtaken us.
        if (seq < this.lastAppliedSeq) return;
        if (this.inFlight?.seq !== seq) return;
        this.lastAppliedSeq = seq;
        this.inFlight = null;
        if (result.updates && Object.keys(result.updates).length > 0) {
          this.options.onUpdates(result.updates);
        }
        if (result.warnings && result.warnings.length > 0) {
          this.options.onWarnings?.(result.warnings);
        }
        this.options.onLoadingChange?.(false, new Set());
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (this.inFlight?.seq !== seq) return;
        this.inFlight = null;
        // Best-effort: log + recover. Onchange must never block submission.
        console.error("[OnchangeDispatcher]", err);
        this.options.onLoadingChange?.(false, new Set());
      });
  }
}
