import { createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import "./i18n"; // Initialize i18n before rendering
import { ShellLayout } from "./layouts/shell";
import { LoginPage } from "./pages/login";
import { SchemaFormPage } from "./pages/schema-form";
import { SchemaListPage } from "./pages/schema-list";
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

// Schema list route — list view for a named schema
const schemaListRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/schemas/$name",
  component: SchemaListPage,
});

// Schema form route — create new record
const schemaFormNewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/schemas/$name/new",
  component: SchemaFormPage,
});

// Schema form route — edit existing record
const schemaFormEditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/schemas/$name/$id",
  component: SchemaFormPage,
});

// Build the route tree and create the router
const routeTree = rootRoute.addChildren([
  workspaceRoute,
  loginRoute,
  schemaListRoute,
  schemaFormNewRoute,
  schemaFormEditRoute,
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
  return <RouterProvider router={router} />;
}
