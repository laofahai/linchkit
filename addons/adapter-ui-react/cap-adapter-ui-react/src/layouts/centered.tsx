import { Outlet } from "@tanstack/react-router";

/** Centered layout for auth pages — full-screen, no sidebar, content centered */
export function CenteredLayout() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40">
      <Outlet />
    </div>
  );
}
