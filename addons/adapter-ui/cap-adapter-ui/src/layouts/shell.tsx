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
  Toaster,
  TooltipProvider,
} from "@linchkit/ui-kit/components";
import { Link, Outlet } from "@tanstack/react-router";
import React, { useCallback, useState } from "react";
import { AIAssistant } from "@/components/ai-assistant";
import { AppSidebar } from "@/components/app-sidebar";
import { CommandPalette } from "@/components/command-palette";
import { HeaderActions } from "@/components/header-actions";
import { useBreadcrumb } from "@/hooks/use-breadcrumb";
import { BreadcrumbTitleProvider } from "@/hooks/use-breadcrumb-title";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { EntityBundleCacheProvider } from "@/hooks/use-entity-bundle";
import { SchemasProvider } from "@/hooks/use-entities";

/** App Shell layout: Shadcn sidebar + header with breadcrumb + main content */
export function ShellLayout() {
  return (
    <SchemasProvider>
      <EntityBundleCacheProvider>
        <BreadcrumbTitleProvider>
          <TooltipProvider delayDuration={0}>
            <ShellContent />
          </TooltipProvider>
        </BreadcrumbTitleProvider>
      </EntityBundleCacheProvider>
    </SchemasProvider>
  );
}

/** Inner shell that consumes SchemasProvider context (needed by useBreadcrumb). */
function ShellContent() {
  const breadcrumbItems = useBreadcrumb();
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const openCommandPalette = useCallback(() => setCmdkOpen(true), []);
  const toggleAI = useCallback(() => setAiOpen((prev) => !prev), []);
  useKeyboardShortcuts({ onOpenCommandPalette: openCommandPalette });

  return (
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
                  // biome-ignore lint/suspicious/noArrayIndexKey: breadcrumb items lack stable ids
                  <React.Fragment key={`${index}-${item.label}`}>
                    {index > 0 && <BreadcrumbSeparator />}
                    <BreadcrumbItemUI>
                      {isLast ? (
                        <BreadcrumbPage>{item.label}</BreadcrumbPage>
                      ) : item.href ? (
                        <BreadcrumbLink asChild>
                          <Link to={item.href as "/"}>{item.label}</Link>
                        </BreadcrumbLink>
                      ) : (
                        <span className="text-muted-foreground">{item.label}</span>
                      )}
                    </BreadcrumbItemUI>
                  </React.Fragment>
                );
              })}
            </BreadcrumbList>
          </Breadcrumb>
          <div className="ml-auto">
            <HeaderActions onOpenCommandPalette={openCommandPalette} onToggleAI={toggleAI} />
          </div>
        </header>
        <div className="flex flex-1 flex-col">
          <Outlet />
        </div>
      </SidebarInset>
      <CommandPalette open={cmdkOpen} onOpenChange={setCmdkOpen} />
      <AIAssistant open={aiOpen} onOpenChange={setAiOpen} />
      <Toaster richColors position="top-right" />
    </SidebarProvider>
  );
}
