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
import "./lib/builtin-panels"; // Register built-in record panels
import { resolveCapabilityPageComponent } from "./capability-page-registry";
import { ErrorBoundary } from "./components/error-boundary";
import { AuthProvider } from "./hooks/use-auth";
import { CenteredLayout } from "./layouts/centered";
import { FullscreenLayout } from "./layouts/fullscreen";
import { ShellLayout } from "./layouts/shell";
import { type AppConfig, fetchAppConfig } from "./lib/api";
import { ConfigCenterPage } from "./pages/config-center";
import { DashboardPage } from "./pages/dashboard";
import { EntityFormPage } from "./pages/entity-form";
import { EntityListPage } from "./pages/entity-list";
import { EvolutionPage } from "./pages/evolution";
import { FlowDetailPage } from "./pages/flow-detail";
import { MetricsDashboardPage } from "./pages/metrics-dashboard";
import { ProposalReviewDemoPage } from "./pages/proposal-review-demo";
import { RelationGraphPage } from "./pages/relation-graph";
import { RuleDetailPage } from "./pages/rule-detail";
import { StateMachineDetailPage } from "./pages/state-machines";
import { SystemOverviewPage } from "./pages/system-overview";

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
  // Per-page boundary at the dynamic-render seam: a broken capability page
  // shows the fallback instead of crashing the surrounding shell.
  const component = () => (
    <ErrorBoundary>
      <ResolvedComponent {...(page.props ?? {})} />
    </ErrorBoundary>
  );

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
    component: DashboardPage,
    beforeLoad: buildPageBeforeLoad("required", "/login", authEnabled),
  });

  const schemaListRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/entities/$name",
    component: EntityListPage,
    beforeLoad: buildPageBeforeLoad("required", "/login", authEnabled),
  });

  const schemaFormNewRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/entities/$name/new",
    component: EntityFormPage,
    validateSearch: (search: Record<string, unknown>) => ({
      clone: (search.clone as string) || undefined,
      parent: (search.parent as string) || undefined,
    }),
    beforeLoad: buildPageBeforeLoad("required", "/login", authEnabled),
  });

  const schemaFormEditRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/entities/$name/$id",
    component: EntityFormPage,
    beforeLoad: buildPageBeforeLoad("required", "/login", authEnabled),
  });

  const systemOverviewRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/admin/system",
    component: SystemOverviewPage,
    beforeLoad: buildPageBeforeLoad("required", "/login", authEnabled),
  });

  const flowDetailRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/admin/flows/$name",
    component: FlowDetailPage,
    beforeLoad: buildPageBeforeLoad("required", "/login", authEnabled),
  });

  const stateMachineDetailRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/admin/states/$name",
    component: StateMachineDetailPage,
    beforeLoad: buildPageBeforeLoad("required", "/login", authEnabled),
  });

  const evolutionRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/admin/evolution",
    component: EvolutionPage,
    beforeLoad: buildPageBeforeLoad("required", "/login", authEnabled),
  });

  const ruleDetailRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/admin/rules/$name",
    component: RuleDetailPage,
    beforeLoad: buildPageBeforeLoad("required", "/login", authEnabled),
  });

  // Settings route removed — merged into /admin/system (SystemOverviewPage)

  const configCenterRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/admin/config",
    component: ConfigCenterPage,
    beforeLoad: buildPageBeforeLoad("required", "/login", authEnabled),
  });

  const relationGraphRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/admin/graph",
    component: RelationGraphPage,
    beforeLoad: buildPageBeforeLoad("required", "/login", authEnabled),
  });

  const metricsDashboardRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/admin/metrics",
    component: MetricsDashboardPage,
    beforeLoad: buildPageBeforeLoad("required", "/login", authEnabled),
  });

  // Spec 55 §7.3 — pre-analysis review panel demo. Renders mock fixtures so the
  // panel is reviewable end-to-end before a real proposal review page lands.
  const proposalReviewDemoRoute = createRoute({
    getParentRoute: () => shellRoute,
    path: "/admin/proposals/preview-demo",
    component: ProposalReviewDemoPage,
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
      systemOverviewRoute,
      flowDetailRoute,
      stateMachineDetailRoute,
      evolutionRoute,
      ruleDetailRoute,
      configCenterRoute,
      relationGraphRoute,
      metricsDashboardRoute,
      proposalReviewDemoRoute,
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
    // Root catch-all: a render error in the providers/router shows the fallback
    // instead of a white screen. On Retry, clear the query cache so any
    // corrupted/failed queries are dropped and refetched fresh.
    <ErrorBoundary onReset={() => queryClient.clear()}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
