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
  SidebarMenuBadge,
} from "@linchkit/ui-kit/components";
import { Link } from "@tanstack/react-router";
import {
  BrainCircuitIcon,
  CheckSquareIcon,
  CircleDotIcon,
  DatabaseIcon,
  GitBranchIcon,
  HeartPulseIcon,
  HistoryIcon,
  LayoutDashboardIcon,
  ScrollTextIcon,
  SettingsIcon,
  ShieldCheckIcon,
  ZapIcon,
} from "lucide-react";
import type * as React from "react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { NavMain } from "@/components/nav-main";
import { NavUser } from "@/components/nav-user";
import { TeamSwitcher } from "@/components/team-switcher";
import { useSchemas } from "@/hooks/use-schemas";
import { useSchemaLabel } from "@/i18n/use-schema-label";
import { getLucideIcon } from "@/lib/dynamic-icon";
import { fetchApprovalCount } from "@/lib/approval-api";
import { fetchPendingCount } from "@/lib/proposal-api";

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { t } = useTranslation();
  const { schemas } = useSchemas();
  const { resolveLabel } = useSchemaLabel();
  const [pendingCount, setPendingCount] = useState(0);
  const [approvalCount, setApprovalCount] = useState(0);

  useEffect(() => {
    fetchPendingCount()
      .then(setPendingCount)
      .catch(() => setPendingCount(0));
    fetchApprovalCount()
      .then(setApprovalCount)
      .catch(() => setApprovalCount(0));
  }, []);

  const data = useMemo(() => {
    // Build schema sub-items from API data with dynamic icons
    const schemaItems = schemas.map((s) => {
      const Icon = getLucideIcon(s.icon);
      return {
        title: resolveLabel(s.label, s.name),
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
          title: t("approvals.title"),
          url: "/admin/approvals",
          icon: <CheckSquareIcon />,
          badgeCount: approvalCount,
        },
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
          title: t("rules.title"),
          url: "/admin/rules",
          icon: <ShieldCheckIcon />,
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
        {
          title: t("settings.title"),
          url: "/admin/settings",
          icon: <SettingsIcon />,
        },
      ],
    };
  }, [schemas, t, resolveLabel, approvalCount]);

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

        {/* AI Evolution section */}
        <SidebarGroup>
          <SidebarGroupLabel>
            <BrainCircuitIcon className="mr-1 h-3 w-3" />
            {t("nav.aiEvolution")}
          </SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip={t("proposals.title")}>
                <Link to="/admin/proposals">
                  <ZapIcon />
                  <span>{t("proposals.navLabel")}</span>
                </Link>
              </SidebarMenuButton>
              {pendingCount > 0 && (
                <SidebarMenuBadge className="bg-yellow-100 dark:bg-yellow-900 text-yellow-700 dark:text-yellow-300 text-[10px] min-w-[18px] h-[18px] flex items-center justify-center rounded-full">
                  {pendingCount}
                </SidebarMenuBadge>
              )}
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip={t("evolution.title")}>
                <Link to="/admin/evolution">
                  <HistoryIcon />
                  <span>{t("evolution.navLabel")}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

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
                {item.badgeCount != null && item.badgeCount > 0 && (
                  <SidebarMenuBadge className="bg-orange-100 dark:bg-orange-900 text-orange-700 dark:text-orange-300 text-[10px] min-w-[18px] h-[18px] flex items-center justify-center rounded-full">
                    {item.badgeCount}
                  </SidebarMenuBadge>
                )}
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
