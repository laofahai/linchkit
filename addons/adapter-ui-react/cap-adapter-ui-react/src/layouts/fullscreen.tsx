import { Outlet } from "@tanstack/react-router";

/** Fullscreen layout — no shell chrome, outlet takes the full viewport. */
export function FullscreenLayout() {
  return <Outlet />;
}
