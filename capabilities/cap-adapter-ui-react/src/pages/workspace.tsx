import { Card, CardContent, CardHeader, CardTitle } from "@linchkit/ui-kit/components";
import { ClipboardList, Eye, FolderOpen, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";

interface WorkspaceCardData {
  titleKey: string;
  descKey: string;
  icon: typeof ClipboardList;
}

const workspaceCards: WorkspaceCardData[] = [
  {
    titleKey: "workspace.myTasks",
    descKey: "workspace.myTasksDesc",
    icon: ClipboardList,
  },
  {
    titleKey: "workspace.aiWatchlist",
    descKey: "workspace.aiWatchlistDesc",
    icon: Eye,
  },
  {
    titleKey: "workspace.myObjects",
    descKey: "workspace.myObjectsDesc",
    icon: FolderOpen,
  },
  {
    titleKey: "workspace.quickActions",
    descKey: "workspace.quickActionsDesc",
    icon: Zap,
  },
];

/** Workspace page — task-driven homepage per spec section 9.3 */
export function WorkspacePage() {
  const { t } = useTranslation();

  return (
    <div className="space-y-6 p-4">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{t("workspace.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("workspace.subtitle")}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {workspaceCards.map((card) => (
          <Card key={card.titleKey} className="transition-colors hover:bg-accent/50">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <card.icon className="h-5 w-5" />
                </div>
                <CardTitle className="text-sm">{t(card.titleKey)}</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{t(card.descKey)}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
