import { useMatches } from "@tanstack/react-router";

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

/**
 * Build breadcrumb items from current route matches.
 * Route context can provide `breadcrumb` label via route context or static data.
 * Falls back to path segment formatting.
 */
export function useBreadcrumb(): BreadcrumbItem[] {
  const matches = useMatches();
  const items: BreadcrumbItem[] = [];

  for (const match of matches) {
    // Skip root route
    if (match.pathname === "/" && matches.length > 1 && match.id === "__root__") {
      continue;
    }

    // Home route
    if (match.pathname === "/" && match.id !== "__root__") {
      items.push({ label: "Home", href: "/" });
      continue;
    }

    // Use route context breadcrumb if available
    const context = match.context as Record<string, unknown> | undefined;
    const staticData = match.staticData as Record<string, unknown> | undefined;
    const breadcrumbLabel = (context?.breadcrumb as string) ?? (staticData?.breadcrumb as string);

    if (breadcrumbLabel) {
      items.push({ label: breadcrumbLabel, href: match.pathname });
      continue;
    }

    // Fall back to formatting the last path segment
    const segments = match.pathname.split("/").filter(Boolean);
    const lastSegment = segments[segments.length - 1];
    if (!lastSegment) continue;

    // Skip param segments that duplicate parent context (e.g. $name, $id)
    // but show them with formatted label
    const label = formatSegment(lastSegment);
    items.push({ label, href: match.pathname });
  }

  return deduplicateItems(items);
}

/** Format a URL segment into a readable label */
function formatSegment(segment: string): string {
  // If it looks like an ID (starts with common prefixes), show as-is
  if (/^[a-f0-9-]{8,}$/.test(segment)) {
    return `${segment.slice(0, 8)}…`;
  }

  return segment.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Remove consecutive duplicate labels */
function deduplicateItems(items: BreadcrumbItem[]): BreadcrumbItem[] {
  return items.filter((item, i) => i === 0 || item.label !== items[i - 1]?.label);
}
