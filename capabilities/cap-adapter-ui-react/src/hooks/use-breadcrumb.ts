import { useMatches } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useSchemaLabel } from "../i18n/use-schema-label";
import { useBreadcrumbTitle } from "./use-breadcrumb-title";
import { useSchemas } from "./use-schemas";

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

/**
 * Well-known route segments mapped to i18n key and whether they are linkable.
 * Segments like "schemas" and "admin" are namespace prefixes without their
 * own route, so they appear in the breadcrumb but are not clickable.
 */
const KNOWN_SEGMENTS: Record<string, { i18nKey: string; linkable: boolean }> = {
  schemas: { i18nKey: "nav.schemas", linkable: false },
  admin: { i18nKey: "nav.administration", linkable: false },
  approvals: { i18nKey: "approvals.title", linkable: true },
  executions: { i18nKey: "executionLog.title", linkable: true },
  health: { i18nKey: "health.title", linkable: true },
  proposals: { i18nKey: "proposals.title", linkable: true },
  evolution: { i18nKey: "evolution.title", linkable: true },
  flows: { i18nKey: "flows.title", linkable: true },
  rules: { i18nKey: "rules.title", linkable: true },
  states: { i18nKey: "stateMachines.title", linkable: true },
  settings: { i18nKey: "settings.title", linkable: true },
  new: { i18nKey: "common.create", linkable: true },
};

/**
 * Build breadcrumb items from the deepest matched route pathname.
 *
 * Because TanStack Router uses flat paths like `/schemas/$name/$id`,
 * there is only one leaf match — not one per segment. We decompose
 * the pathname into cumulative segments and resolve each label via:
 *
 *   1. Well-known segment -> i18n key
 *   2. Schema name -> schema label (via useSchemaLabel resolver)
 *   3. Record ID -> custom title from BreadcrumbTitleContext, or truncated hash
 *   4. Fallback: capitalize raw segment
 */
export function useBreadcrumb(): BreadcrumbItem[] {
  const matches = useMatches();
  const { t } = useTranslation();
  const { schemas } = useSchemas();
  const { resolveLabel } = useSchemaLabel();
  const { title: customTitle } = useBreadcrumbTitle();

  // Find the deepest non-layout match to get the full pathname
  const leafMatch = matches[matches.length - 1];
  if (!leafMatch) return [];

  const pathname = leafMatch.pathname;

  // Home page — single item, no link needed
  if (pathname === "/") {
    return [{ label: t("nav.home") }];
  }

  // Build cumulative breadcrumb from path segments
  const segments = pathname.split("/").filter(Boolean);
  const items: BreadcrumbItem[] = [{ label: t("nav.home"), href: "/" }];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] ?? "";
    const cumulativePath = `/${segments.slice(0, i + 1).join("/")}`;
    const isLast = i === segments.length - 1;
    const parentSegment = i > 0 ? segments[i - 1] : undefined;

    const resolved = resolveSegmentLabel(
      segment,
      parentSegment,
      isLast,
      t,
      schemas,
      resolveLabel,
      customTitle,
    );

    items.push({
      label: resolved.label,
      // Last item never links; non-linkable segments (namespace prefixes) also skip href
      href: isLast ? undefined : resolved.linkable ? cumulativePath : undefined,
    });
  }

  return items;
}

interface ResolvedSegment {
  label: string;
  linkable: boolean;
}

/**
 * Resolve a human-readable label for a URL segment.
 */
function resolveSegmentLabel(
  segment: string,
  parentSegment: string | undefined,
  isLast: boolean,
  t: (key: string, opts?: Record<string, unknown>) => string,
  schemas: Array<{ name: string; label?: string }>,
  resolveLabel: (label: string | undefined, fallback: string) => string,
  customTitle: string | null,
): ResolvedSegment {
  // 1. Well-known segment
  const known = KNOWN_SEGMENTS[segment];
  if (known) {
    return { label: t(known.i18nKey), linkable: known.linkable };
  }

  // 2. Schema name — when parent is "schemas"
  if (parentSegment === "schemas") {
    const schemaInfo = schemas.find((s) => s.name === segment);
    if (schemaInfo?.label) {
      return { label: resolveLabel(schemaInfo.label, formatSegment(segment)), linkable: true };
    }
    // Try i18n key: schemas.<name>._label
    const schemaI18nLabel = t(`schemas.${segment}._label`, { defaultValue: "" });
    if (schemaI18nLabel) {
      return { label: schemaI18nLabel, linkable: true };
    }
    return { label: formatSegment(segment), linkable: true };
  }

  // 3. Record IDs — use custom title from page context when available
  if (/^[a-f0-9-]{8,}$/.test(segment)) {
    if (isLast && customTitle) {
      return { label: customTitle, linkable: true };
    }
    return { label: `#${segment.slice(0, 8)}`, linkable: true };
  }

  // 4. Try i18n nav key before falling back to title-case
  const navKey = `nav.${segment}`;
  const navTranslation = t(navKey, { defaultValue: "" });
  if (navTranslation) {
    return { label: navTranslation, linkable: true };
  }

  // 5. Fallback: title-case English
  return { label: formatSegment(segment), linkable: true };
}

/** Format a URL segment into a readable label */
function formatSegment(segment: string): string {
  return segment.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
