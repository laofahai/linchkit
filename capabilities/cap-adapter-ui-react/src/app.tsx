import type { PageAuth, PageLayout, PageRegistration } from "@linchkit/core";
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  redirect,
} from "@tanstack/react-router";
import config from "../../../linchkit.config";
import "./i18n"; // Initialize i18n before rendering
import { resolveCapabilityPageComponent } from "./capability-page-registry";
import { AuthProvider } from "./hooks/use-auth";
import { CenteredLayout } from "./layouts/centered";
import { FullscreenLayout } from "./layouts/fullscreen";
import { ShellLayout } from "./layouts/shell";
import { isAuthenticated } from "./lib/auth-client";
import { ExecutionLogsPage } from "./pages/execution-logs";
import { SchemaFormPage } from "./pages/schema-form";
import { SchemaListPage } from "./pages/schema-list";
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

function buildPageBeforeLoad(auth: PageAuth, redirectOnFail?: string) {
  return () => {
    if (auth === "required" && !isAuthenticated()) {
      throw redirect({ to: redirectOnFail ?? "/login" });
    }

    if (auth === "anonymous" && isAuthenticated()) {
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

const capabilityPages = (config.capabilities ?? []).flatMap((capability) => capability.pages ?? []);

function createCapabilityPageRoute(page: PageRegistration) {
  const parentRoute = getLayoutRoute(page.layout);
  const ResolvedComponent = resolveCapabilityPageComponent(page);
  const component = () => <ResolvedComponent {...(page.props ?? {})} />;

  return createRoute({
    getParentRoute: () => parentRoute,
    path: page.path,
    component,
    beforeLoad: buildPageBeforeLoad(page.auth, page.redirectOnFail),
  });
}

// ── Shell children (authenticated) ────────────────────────────────

const workspaceRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/",
  component: WorkspacePage,
  beforeLoad: buildPageBeforeLoad("required", "/login"),
});

const schemaListRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/schemas/$name",
  component: SchemaListPage,
  beforeLoad: buildPageBeforeLoad("required", "/login"),
});

const schemaFormNewRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/schemas/$name/new",
  component: SchemaFormPage,
  beforeLoad: buildPageBeforeLoad("required", "/login"),
});

const schemaFormEditRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/schemas/$name/$id",
  component: SchemaFormPage,
  beforeLoad: buildPageBeforeLoad("required", "/login"),
});

const executionLogsRoute = createRoute({
  getParentRoute: () => shellRoute,
  path: "/admin/executions",
  component: ExecutionLogsPage,
  beforeLoad: buildPageBeforeLoad("required", "/login"),
});

// ── Route tree ────────────────────────────────────────────────────

const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([
    workspaceRoute,
    schemaListRoute,
    schemaFormNewRoute,
    schemaFormEditRoute,
    executionLogsRoute,
    ...capabilityPages.filter((page) => page.layout === "shell").map(createCapabilityPageRoute),
  ]),
  centeredRoute.addChildren(
    capabilityPages.filter((page) => page.layout === "centered").map(createCapabilityPageRoute),
  ),
  fullscreenRoute.addChildren(
    capabilityPages.filter((page) => page.layout === "fullscreen").map(createCapabilityPageRoute),
  ),
]);

const router = createRouter({ routeTree });

// Register the router for type safety
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

/** Root App component */
export function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  );
}
