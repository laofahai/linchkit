import {
  Breadcrumb,
  BreadcrumbItem as BreadcrumbItemUI,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Separator,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  TooltipProvider,
} from "@linchkit/ui-kit/components";
import { Link, Outlet } from "@tanstack/react-router";
import React, { useCallback, useState } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { CommandPalette } from "@/components/command-palette";
import { HeaderActions } from "@/components/header-actions";
import { useBreadcrumb } from "@/hooks/use-breadcrumb";
import { SchemaBundleCacheProvider } from "@/hooks/use-schema-bundle";
import { SchemasProvider } from "@/hooks/use-schemas";

/** App Shell layout: Shadcn sidebar + header with breadcrumb + main content */
export function ShellLayout() {
  const breadcrumbItems = useBreadcrumb();
  const [cmdkOpen, setCmdkOpen] = useState(false);

  const openCommandPalette = useCallback(() => setCmdkOpen(true), []);

  return (
    <SchemasProvider>
      <SchemaBundleCacheProvider>
        <TooltipProvider delayDuration={0}>
          <SidebarProvider>
            <AppSidebar />
            <SidebarInset>
              <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
                <SidebarTrigger className="-ml-1" />
                <Separator
                  orientation="vertical"
                  className="mx-2 data-[orientation=vertical]:self-auto data-[orientation=vertical]:h-4"
                />
                <Breadcrumb>
                  <BreadcrumbList>
                    {breadcrumbItems.map((item, index) => {
                      const isLast = index === breadcrumbItems.length - 1;
                      return (
                        <React.Fragment key={item.href ?? item.label}>
                          {index > 0 && <BreadcrumbSeparator />}
                          <BreadcrumbItemUI>
                            {isLast ? (
                              <BreadcrumbPage>{item.label}</BreadcrumbPage>
                            ) : (
                              <BreadcrumbLink asChild>
                                <Link to={item.href as "/"}>{item.label}</Link>
                              </BreadcrumbLink>
                            )}
                          </BreadcrumbItemUI>
                        </React.Fragment>
                      );
                    })}
                  </BreadcrumbList>
                </Breadcrumb>
                <div className="ml-auto">
                  <HeaderActions onOpenCommandPalette={openCommandPalette} />
                </div>
              </header>
              <div className="flex flex-1 flex-col">
                <Outlet />
              </div>
            </SidebarInset>
            <CommandPalette open={cmdkOpen} onOpenChange={setCmdkOpen} />
          </SidebarProvider>
        </TooltipProvider>
      </SchemaBundleCacheProvider>
    </SchemasProvider>
  );
}
