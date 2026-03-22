import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@linchkit/ui-kit/components";
import { Link } from "@tanstack/react-router";
import {
  ActivityIcon,
  BlocksIcon,
  BoxIcon,
  DatabaseIcon,
  LayoutDashboardIcon,
  ScrollTextIcon,
  Settings2Icon,
} from "lucide-react";
import type * as React from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { NavMain } from "@/components/nav-main";
import { NavUser } from "@/components/nav-user";
import { TeamSwitcher } from "@/components/team-switcher";
import { useSchemas } from "@/hooks/use-schemas";

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { t } = useTranslation();
  const { schemas } = useSchemas();

  const data = useMemo(() => {
    // Build schema sub-items from API data
    const schemaItems = schemas.map((s) => ({
      title: s.label ?? s.name,
      url: `/schemas/${s.name}`,
    }));

    // No hardcoded fallback — sidebar reflects actual server state

    return {
      user: {
        name: "Admin",
        email: "admin@linchkit.dev",
        avatar: "",
      },
      teams: [
        {
          name: "LinchKit",
          logo: <BoxIcon />,
          plan: t("nav.workspace"),
        },
      ],
      navMain: [
        {
          title: t("nav.capabilities"),
          url: "/modules",
          icon: <BlocksIcon />,
          items: [],
        },
        {
          title: t("nav.schemas"),
          url: "#",
          icon: <DatabaseIcon />,
          isActive: true,
          items: schemaItems,
        },
        {
          title: t("nav.events"),
          url: "/admin/events",
          icon: <ActivityIcon />,
          items: [],
        },
        {
          title: t("executionLog.title"),
          url: "/admin/executions",
          icon: <ScrollTextIcon />,
          items: [],
        },
        {
          title: t("nav.settings"),
          url: "/admin/settings",
          icon: <Settings2Icon />,
          items: [],
        },
      ],
    };
  }, [schemas, t]);

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <TeamSwitcher teams={data.teams} />
      </SidebarHeader>
      <SidebarContent>
        {/* Workspace section */}
        <SidebarGroup>
          <SidebarGroupLabel>{t("nav.workspace")}</SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip={t("nav.home")}>
                <Link to="/">
                  <LayoutDashboardIcon />
                  <span>{t("nav.home")}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        {/* Administration section */}
        <NavMain items={data.navMain} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={data.user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
