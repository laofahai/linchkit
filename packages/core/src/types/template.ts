/**
 * RecordTemplate — pre-filled field value presets for schema record creation (Spec 54 §7).
 */

export interface RecordTemplate {
  id: string;
  /** Schema this template belongs to */
  entityName: string;
  /** Display name, e.g. "Standard IT Purchase" */
  name: string;
  /** Optional description */
  description?: string;
  /** Optional icon name (Lucide) */
  icon?: string;
  /** Pre-filled field values (partial record data) */
  values: Record<string, unknown>;
  /** Whether available to all users in tenant */
  isShared?: boolean;
  /** Display order */
  sortOrder?: number;
  createdAt: string;
  updatedAt?: string;
}

export interface CreateRecordTemplateInput {
  entityName: string;
  name: string;
  description?: string;
  icon?: string;
  values: Record<string, unknown>;
  isShared?: boolean;
  sortOrder?: number;
}
