import type { ReactNode } from "react";
import { AutoList } from "../auto-list";
import type { AutoListProps } from "../auto-list/types";
import { SavedViewTabs, type SavedViewTabsProps } from "../auto-list/saved-view-tabs";
import { SearchBar, type SearchBarProps } from "../auto-list/search-bar";
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

	/** Primary action button rendered consistently across all view modes. */
	primaryActionSlot?: ReactNode;

	/** Search bar props for alternate views (calendar/kanban/tree). When provided,
	 *  a SearchBar is rendered above the alternate view content. */
	searchBarProps?: SearchBarProps;
}

/**
 * ListView — Unified wrapper for all list pages.
 *
 * Composes: page wrapper + optional SavedViewTabs + optional ViewToggle + AutoList.
 * When an alternate view (calendar/kanban/tree) is active, a consistent mini-toolbar
 * with the primary action button, refresh indicator and view toggle is shown above
 * the alternate content. The ViewToggle stays in the same position regardless of
 * active view mode.
 */
export function ListView({
	className,
	savedViews,
	viewToggle,
	alternateViewContent,
	refreshIndicator,
	afterContent,
	toolbarExtra,
	primaryActionSlot,
	searchBarProps,
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

			{alternateViewContent ? (
				<div className="space-y-4">
					{/* Toolbar for alternate views: SearchBar + actions */}
					<div className="flex flex-wrap items-center gap-3">
						{/* Left: SearchBar (same filtering as list view) */}
						{searchBarProps && (
							<SearchBar
								{...searchBarProps}
								className="w-full max-w-md md:w-auto"
							/>
						)}

						<div className="hidden flex-1 md:block" />

						{/* Right: actions + view toggle */}
						<div className="flex shrink-0 items-center gap-2">
							{primaryActionSlot}
							{refreshIndicator}
							{viewToggle && <ViewToggle {...viewToggle} />}
						</div>
					</div>
					{alternateViewContent}
				</div>
			) : (
				<AutoList {...autoListProps} toolbarExtra={composedToolbarExtra} />
			)}

			{afterContent}
		</div>
	);
}
