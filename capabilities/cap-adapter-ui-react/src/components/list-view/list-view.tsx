import type { ReactNode } from "react";
import { AutoList } from "../auto-list";
import type { AutoListProps } from "../auto-list/types";
import { SavedViewTabs, type SavedViewTabsProps } from "../auto-list/saved-view-tabs";
import { ViewToggle, type ViewToggleConfig } from "./view-toggle";
import { cn } from "@linchkit/ui-kit/lib/utils";

export interface ListViewProps extends AutoListProps {
	/** Outer wrapper class. Default: "p-4". */
	className?: string;

	/** Saved view tabs configuration (opt-in). */
	savedViews?: SavedViewTabsProps;

	/** Segmented view toggle configuration (opt-in). */
	viewToggle?: ViewToggleConfig;

	/** Content rendered instead of AutoList when a non-list view is active. */
	alternateViewContent?: ReactNode;

	/** Refresh indicator (e.g. SSE "Refreshing..." chip). */
	refreshIndicator?: ReactNode;

	/** Content rendered after the list (dialogs, expanded panels, etc.). */
	afterContent?: ReactNode;
}

/**
 * ListView — Unified wrapper for all list pages.
 *
 * Composes: page wrapper + optional SavedViewTabs + optional ViewToggle + AutoList.
 * Admin pages pass only basic AutoList props for minimal usage.
 * Schema pages pass full config for saved views, view toggle, and alternate views.
 */
export function ListView({
	className,
	savedViews,
	viewToggle,
	alternateViewContent,
	refreshIndicator,
	afterContent,
	toolbarExtra,
	...autoListProps
}: ListViewProps) {
	// Compose toolbar extra: caller's extra + refresh indicator + view toggle
	const composedToolbarExtra =
		toolbarExtra || refreshIndicator || viewToggle ? (
			<div className="flex items-center gap-2">
				{toolbarExtra}
				{refreshIndicator}
				{viewToggle && <ViewToggle {...viewToggle} />}
			</div>
		) : null;

	return (
		<div className={cn("p-4", savedViews && "space-y-3", className)}>
			{savedViews && <SavedViewTabs {...savedViews} />}

			{alternateViewContent || (
				<AutoList {...autoListProps} toolbarExtra={composedToolbarExtra} />
			)}

			{afterContent}
		</div>
	);
}
