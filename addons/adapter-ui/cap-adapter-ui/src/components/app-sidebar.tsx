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
import { DatabaseIcon, LayoutDashboardIcon, ScrollTextIcon } from "lucide-react";
import type * as React from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { NavMain } from "@/components/nav-main";
import { NavUser } from "@/components/nav-user";
import { TeamSwitcher } from "@/components/team-switcher";
import { useEntities } from "@/hooks/use-entities";
import { useSchemaLabel } from "@/i18n/use-entity-label";
import { getMenuItems } from "@/lib/api";
import { getLucideIcon } from "@/lib/dynamic-icon";

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { t } = useTranslation();
  const { schemas } = useEntities();
  const { resolveLabel } = useSchemaLabel();

  const data = useMemo(() => {
    // Split schemas into business vs system (internal) groups
    const businessSchemas = schemas.filter((s) => !s.internal);
    const systemSchemas = schemas.filter((s) => s.internal);

    const toNavItem = (s: (typeof schemas)[0]) => {
      const Icon = getLucideIcon(s.icon);
      return {
        title: resolveLabel(s.label, s.name),
        url: `/schemas/${s.name}`,
        icon: Icon ? <Icon className="size-4" /> : undefined,
      };
    };

    // Collect and sort admin menu items from capability registrations
    const registeredMenuItems = getMenuItems();
    const adminItems = registeredMenuItems
      .filter((item) => item.section === "admin")
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((item) => {
        const resolvedLabel = item.label.startsWith("t:") ? t(item.label.slice(2)) : item.label;
        const Icon = getLucideIcon(item.icon);
        return {
          id: item.id,
          title: resolvedLabel,
          url: item.path,
          icon: Icon,
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
          items: businessSchemas.map(toNavItem),
        },
        ...(systemSchemas.length > 0
          ? [
              {
                title: t("nav.system"),
                url: "#",
                icon: <ScrollTextIcon />,
                isActive: false,
                items: systemSchemas.map(toNavItem),
              },
            ]
          : []),
      ],
      adminItems,
    };
  }, [schemas, t, resolveLabel]);

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

        {/* Administration section — dynamically populated from capability menuItems */}
        {data.adminItems.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>{t("nav.administration")}</SidebarGroupLabel>
            <SidebarMenu>
              {data.adminItems.map((item) => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton asChild tooltip={item.title}>
                    <Link to={item.url as "/"}>
                      {item.icon && <item.icon />}
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter>
        <NavUser />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
