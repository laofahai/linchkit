import type { PageAuth, PageLayout, PageRegistration } from "@linchkit/core/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  redirect,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      retry: 1,
    },
  },
});
import "./i18n"; // Initialize i18n before rendering
import { resolveCapabilityPageComponent } from "./capability-page-registry";
import { AuthProvider } from "./hooks/use-auth";
import { CenteredLayout } from "./layouts/centered";
import { FullscreenLayout } from "./layouts/fullscreen";
import { ShellLayout } from "./layouts/shell";
import { type AppConfig, fetchAppConfig } from "./lib/api";
import { ExecutionLogsPage } from "./pages/execution-logs";
import { FlowDetailPage } from "./pages/flow-detail";
import { FlowsPage } from "./pages/flows";
import { HealthMonitorPage } from "./pages/health-monitor";
import { SchemaFormPage } from "./pages/schema-form";
import { SchemaListPage } from "./pages/schema-list";
import { StateMachineDetailPage, StateMachinesPage } from "./pages/state-machines";
import { EvolutionPage } from "./pages/evolution";
import { ProposalsPage } from "./pages/proposals";
import { WorkspacePage } from "./pages/workspace";

// ── Root route (no layout) ────────────────────────────────────────

const rootRoute = createRootRoute();

// ── Layout roots ─────────────────────────────────────────────────

const shellRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "shell",
  component: ShellLayout,
});

const centeredRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "centered",
  component: CenteredLayout,
});

const fullscreenRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "fullscreen",
  component: FullscreenLayout,
});

/** Check token validity (not just the localStorage flag). */
function isTokenValid(): boolean {
  const token = localStorage.getItem("linchkit:token");
  if (!token) return false;
  try {
    const parts = token.split(".");
    const raw = parts.length === 3 ? (parts[1] ?? token) : token;
    const base64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
    const payload = JSON.parse(atob(padded));
    if (typeof payload.exp === "number") {
      const expiresAtMs = payload.exp > 1e12 ? payload.exp : payload.exp * 1000;
      if (Date.now() >= expiresAtMs) {
        localStorage.removeItem("linchkit:token");
        localStorage.removeItem("linchkit:authenticated");
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a beforeLoad guard for route authentication.
 * When authEnabled is false, all guards are skipped — the app runs without auth.
 */
function buildPageBeforeLoad(auth: PageAuth, redirectOnFail?: string, authEnabled = true) {
  return () => {
    if (!authEnabled) return; // No auth capability loaded — skip all guards
    if (auth === "required" && !isTokenValid()) {
      throw redirect({ to: redirectOnFail ?? "/login" });
    }

    if (auth === "anonymous" && isTokenValid()) {
      throw redirect({ to: redirectOnFail ?? "/" });
    }
  };
}

function getLayoutRoute(layout: PageLayout) {
  switch (layout) {
    case "shell":
      return shellRoute;
    case "fullscreen":
      return fullscreenRoute;
    default:
      return centeredRoute;
  }
}

function createCapabilityPageRoute(page: PageRegistration, authEnabled: boolean) {
  const parentRoute = getLayoutRoute(page.layout);
  const ResolvedComponent = resolveCapabilityPageComponent(page);
  const component = () => <ResolvedComponent {...(page.props ?? {})} />;

  return createRoute({
    getParentRoute: () => parentRoute,
    path: page.path,
    component,
    beforeLoad: buildPageBeforeLoad(page.auth, page.redirectOnFail, authEnabled),
  });
}

/** Build the router with the given app config. */
function buildRouter(appConfig: AppConfig) {
  const { authEnabled, pages: capabilityPages } = appConfig;

  // ── Shell children ────────────────────────────────
  const workspaceRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/",
    component: WorkspacePage,
    beforeLoad: buildPageBeforeLoad("required", "/login", authEnabled),
  });

  const schemaListRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/schemas/$name",
    component: SchemaListPage,
    beforeLoad: buildPageBeforeLoad("required", "/login", authEnabled),
  });

  const schemaFormNewRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/schemas/$name/new",
    component: SchemaFormPage,
    validateSearch: (search: Record<string, unknown>) => ({
      clone: (search.clone as string) || undefined,
    }),
    beforeLoad: buildPageBeforeLoad("required", "/login", authEnabled),
  });

  const schemaFormEditRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/schemas/$name/$id",
    component: SchemaFormPage,
    beforeLoad: buildPageBeforeLoad("required", "/login", authEnabled),
  });

  const executionLogsRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/admin/executions",
    component: ExecutionLogsPage,
    beforeLoad: buildPageBeforeLoad("required", "/login", authEnabled),
  });

  const healthMonitorRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/admin/health",
    component: HealthMonitorPage,
    beforeLoad: buildPageBeforeLoad("required", "/login", authEnabled),
  });

  const flowsRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/admin/flows",
    component: FlowsPage,
    beforeLoad: buildPageBeforeLoad("required", "/login", authEnabled),
  });

  const flowDetailRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/admin/flows/$name",
    component: FlowDetailPage,
    beforeLoad: buildPageBeforeLoad("required", "/login", authEnabled),
  });

  const stateMachinesRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/admin/states",
    component: StateMachinesPage,
    beforeLoad: buildPageBeforeLoad("required", "/login", authEnabled),
  });

  const stateMachineDetailRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/admin/states/$name",
    component: StateMachineDetailPage,
    beforeLoad: buildPageBeforeLoad("required", "/login", authEnabled),
  });

  const proposalsRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/admin/proposals",
    component: ProposalsPage,
    beforeLoad: buildPageBeforeLoad("required", "/login", authEnabled),
  });

  const evolutionRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/admin/evolution",
    component: EvolutionPage,
    beforeLoad: buildPageBeforeLoad("required", "/login", authEnabled),
  });

  // Build capability page routes from server response
  const pageRegistrations = capabilityPages as PageRegistration[];

  const routeTree = rootRoute.addChildren([
    shellRoute.addChildren([
      workspaceRoute,
      schemaListRoute,
      schemaFormNewRoute,
      schemaFormEditRoute,
      executionLogsRoute,
      healthMonitorRoute,
      flowsRoute,
      flowDetailRoute,
      stateMachinesRoute,
      stateMachineDetailRoute,
      ...pageRegistrations
        .filter((page) => page.layout === "shell")
        .map((p) => createCapabilityPageRoute(p, authEnabled)),
    ]),
    centeredRoute.addChildren(
      pageRegistrations
        .filter((page) => page.layout === "centered")
        .map((p) => createCapabilityPageRoute(p, authEnabled)),
    ),
    fullscreenRoute.addChildren(
      pageRegistrations
        .filter((page) => page.layout === "fullscreen")
        .map((p) => createCapabilityPageRoute(p, authEnabled)),
    ),
  ]);

  return createRouter({ routeTree });
}

/** Root App component — fetches app config before building routes. */
export function App() {
  // biome-ignore lint/suspicious/noExplicitAny: TanStack Router generic types are complex
  const [router, setRouter] = useState<any>(null);

  useEffect(() => {
    fetchAppConfig().then((config) => {
      setRouter(buildRouter(config));
    });
  }, []);

  if (!router) {
    // Loading state while fetching app config
    return null;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  );
}
