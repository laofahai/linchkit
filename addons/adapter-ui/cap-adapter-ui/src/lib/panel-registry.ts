/**
 * Panel Registry — declarative UI panel registration for capabilities.
 *
 * Capabilities register panels at import time via registerRecordPanel().
 * The schema-form page reads the registry and conditionally renders panels
 * based on which backend capabilities are active (via app-config).
 */

import type { FieldDefinition } from "@linchkit/core/types";

/** Props passed to every record panel component */
export interface RecordPanelProps {
  entityName: string;
  recordId: string;
  record?: Record<string, unknown>;
  fields?: Record<string, FieldDefinition>;
  recordFields?: string[];
  onRestore?: () => void;
}

/** Panel registration record */
export interface RecordPanelRegistration {
  /** Unique identifier */
  id: string;
  /** Backend capability this panel depends on (or "__builtin__" for core panels) */
  capability: string;
  /** Mount slot */
  slot: "record-detail-tab";
  /** Tab label (supports i18n key via t()) */
  label: string;
  /** Lucide icon name (PascalCase) */
  icon?: string;
  /** Sort order (lower = earlier, default 100) */
  order?: number;
  /** Lazy-loaded React component */
  component: () => Promise<{
    default: React.ComponentType<RecordPanelProps>;
  }>;
}

const registry: RecordPanelRegistration[] = [];

/** Register a record-detail panel. Called at import time by capability UI packages. */
export function registerRecordPanel(panel: RecordPanelRegistration): void {
  if (registry.some((p) => p.id === panel.id)) {
    throw new Error(`Record panel "${panel.id}" is already registered`);
  }
  registry.push(panel);
}

/** Get all registered panels, sorted by order. */
export function getRecordPanels(): RecordPanelRegistration[] {
  return [...registry].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
}

/** Clear all registrations (for testing only). */
export function clearRecordPanels(): void {
  registry.length = 0;
}
