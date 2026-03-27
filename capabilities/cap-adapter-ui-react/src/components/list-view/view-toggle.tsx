import { Button } from "@linchkit/ui-kit/components";
import { cn } from "@linchkit/ui-kit/lib/utils";
import type { ReactNode } from "react";

export interface ViewOption {
	key: string;
	icon: ReactNode;
	label: string;
}

export interface ViewToggleConfig {
	options: ViewOption[];
	activeView: string;
	onViewChange: (view: string) => void;
}

/** Segmented control for switching between list/kanban/calendar/tree views. */
export function ViewToggle({ options, activeView, onViewChange }: ViewToggleConfig) {
	if (options.length === 0) return null;

	return (
		<div className="flex items-center rounded-md bg-muted p-0.5">
			{options.map((opt) => (
				<Button
					key={opt.key}
					variant={activeView === opt.key ? "secondary" : "ghost"}
					size="icon-sm"
					className={cn(
						"h-6 w-6",
						activeView !== opt.key &&
							"text-muted-foreground hover:bg-transparent hover:text-foreground",
					)}
					onClick={() => onViewChange(opt.key)}
					title={opt.label}
				>
					{opt.icon}
				</Button>
			))}
		</div>
	);
}
