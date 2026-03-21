import { createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { ShellLayout } from "./layouts/shell";
import { LoginPage } from "./pages/login";
import { WorkspacePage } from "./pages/workspace";

// Root route — uses the shell layout
const rootRoute = createRootRoute({
  component: ShellLayout,
});

// Workspace route — task-driven homepage
const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: WorkspacePage,
});

// Login route — standalone page (no shell)
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

// Build the route tree and create the router
const routeTree = rootRoute.addChildren([workspaceRoute, loginRoute]);

const router = createRouter({ routeTree });

// Register the router for type safety
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

/** Root App component */
export function App() {
  return <RouterProvider router={router} />;
}
