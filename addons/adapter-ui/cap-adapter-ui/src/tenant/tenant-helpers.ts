/**
 * Pure helpers for the tenant self-service surface.
 *
 * Kept dependency-free so they are easy to unit test and reuse.
 */

import type { TenantMemberRole } from "./tenant-self-service-types";

/** Basic RFC-5322-ish email shape check. Strict enough for UI gating. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Returns true when the input looks like a syntactically valid email. */
export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

/** Hex colour validation. Accepts 3 or 6 hex digits with leading `#`. */
const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isValidHexColor(value: string): boolean {
  return HEX_COLOR_RE.test(value.trim());
}

/**
 * Format a byte count as a human-readable string (KB / MB / GB / TB).
 *
 * Uses binary units (1024). Returns `"0 B"` for zero / negatives.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const exp = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exp;
  // Show 1 decimal once we leave bytes; integers feel cleaner for the smallest unit.
  return `${exp === 0 ? value : value.toFixed(1)} ${units[exp]}`;
}

/**
 * Format a usage ratio (used / limit) as a clamped percentage string with
 * a single decimal. Returns `"0%"` when the limit is non-positive.
 */
export function formatUsageRatio(used: number, limit: number): string {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return "0%";
  const pct = Math.max(0, Math.min(used / limit, 1)) * 100;
  return `${pct.toFixed(1)}%`;
}

/** Roles the UI offers when inviting a member. `owner` is intentionally excluded. */
export const INVITABLE_ROLES: readonly TenantMemberRole[] = ["admin", "member", "viewer"] as const;

/** True if a role is one the UI lets the current admin assign via invite. */
export function isInvitableRole(role: string): role is TenantMemberRole {
  return (INVITABLE_ROLES as readonly string[]).includes(role);
}
