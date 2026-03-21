import type * as React from "react"

import { LanguageSwitcher } from "@/components/language-switcher"
import { NavMain } from "@/components/nav-main"
import { NavUser } from "@/components/nav-user"
import { TeamSwitcher } from "@/components/team-switcher"
import { ThemeToggle } from "@/components/theme-toggle"
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
} from "@/components/ui/sidebar"
import { Link } from "@tanstack/react-router"
import {
  ActivityIcon,
  BlocksIcon,
  BoxIcon,
  DatabaseIcon,
  LayoutDashboardIcon,
  Settings2Icon,
} from "lucide-react"
import { useTranslation } from "react-i18next"

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { t } = useTranslation()

  const data = {
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
        items: [
          {
            title: "Purchase Request",
            url: "/schemas/purchase_request",
          },
        ],
      },
      {
        title: t("nav.events"),
        url: "/admin/events",
        icon: <ActivityIcon />,
        items: [],
      },
      {
        title: t("nav.settings"),
        url: "/admin/settings",
        icon: <Settings2Icon />,
        items: [],
      },
    ],
  }

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
        <SidebarMenu>
          <SidebarMenuItem>
            <LanguageSwitcher />
          </SidebarMenuItem>
        </SidebarMenu>
        <ThemeToggle />
        <NavUser user={data.user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
