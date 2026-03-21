import { ClipboardList, Eye, FolderOpen, Zap } from "lucide-react";

interface WorkspaceCardProps {
  title: string;
  description: string;
  icon: typeof ClipboardList;
}

/** Single card in the workspace grid */
function WorkspaceCard({ title, description, icon: Icon }: WorkspaceCardProps) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5">
      <div className="mb-3 flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-gray-100 text-gray-600">
          <Icon className="h-5 w-5" />
        </div>
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
      </div>
      <p className="text-sm text-gray-500">{description}</p>
    </div>
  );
}

const workspaceCards: WorkspaceCardProps[] = [
  {
    title: "My Tasks",
    description:
      "Pending approvals, proposals awaiting confirmation, and items requiring your action.",
    icon: ClipboardList,
  },
  {
    title: "AI Watchlist",
    description:
      "Anomalies triggered by rules, alerts from event handlers, and AI-identified risks.",
    icon: Eye,
  },
  {
    title: "My Objects",
    description: "Bookmarked records, objects you own, and recently accessed items.",
    icon: FolderOpen,
  },
  {
    title: "Quick Actions",
    description: "Launch common actions or use natural language via Command Palette.",
    icon: Zap,
  },
];

/** Workspace page — task-driven homepage per spec section 9.3 */
export function WorkspacePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Workspace</h1>
        <p className="mt-1 text-sm text-gray-500">
          Your task-driven home. Everything that needs your attention, in one place.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {workspaceCards.map((card) => (
          <WorkspaceCard
            key={card.title}
            title={card.title}
            description={card.description}
            icon={card.icon}
          />
        ))}
      </div>
    </div>
  );
}
