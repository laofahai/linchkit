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
  CircleDotIcon,
  DatabaseIcon,
  GitBranchIcon,
  HeartPulseIcon,
  LayoutDashboardIcon,
  ScrollTextIcon,
} from "lucide-react";
import type * as React from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { NavMain } from "@/components/nav-main";
import { NavUser } from "@/components/nav-user";
import { TeamSwitcher } from "@/components/team-switcher";
import { useSchemas } from "@/hooks/use-schemas";
import { getLucideIcon } from "@/lib/dynamic-icon";

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { t } = useTranslation();
  const { schemas } = useSchemas();

  const data = useMemo(() => {
    // Build schema sub-items from API data with dynamic icons
    const schemaItems = schemas.map((s) => {
      const Icon = getLucideIcon(s.icon);
      return {
        title: s.label ?? s.name,
        url: `/schemas/${s.name}`,
        icon: Icon ? <Icon className="size-4" /> : undefined,
      };
    });

    return {
      teams: [
        {
          name: "LinchKit",
          logo: <DatabaseIcon />,
          plan: t("nav.workspace"),
        },
      ],
      navMain: [
        {
          title: t("nav.schemas"),
          url: "#",
          icon: <DatabaseIcon />,
          isActive: true,
          items: schemaItems,
        },
      ],
      adminItems: [
        {
          title: t("flows.title"),
          url: "/admin/flows",
          icon: <GitBranchIcon />,
        },
        {
          title: t("stateMachines.title"),
          url: "/admin/states",
          icon: <CircleDotIcon />,
        },
        {
          title: t("executionLog.title"),
          url: "/admin/executions",
          icon: <ScrollTextIcon />,
        },
        {
          title: t("health.title"),
          url: "/admin/health",
          icon: <HeartPulseIcon />,
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

        {/* Schema models section — dynamically generated from API */}
        <NavMain items={data.navMain} />

        {/* Administration section — only items with working routes */}
        <SidebarGroup>
          <SidebarGroupLabel>{t("nav.administration")}</SidebarGroupLabel>
          <SidebarMenu>
            {data.adminItems.map((item) => (
              <SidebarMenuItem key={item.url}>
                <SidebarMenuButton asChild tooltip={item.title}>
                  <Link to={item.url as "/"}>
                    {item.icon}
                    <span>{item.title}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
