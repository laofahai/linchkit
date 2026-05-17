/**
 * Capability definition for cap-theme.
 *
 * Ships the {@link ThemeProvider}, {@link useTheme} hook and {@link
 * ThemeToggle} button used to drive the Tailwind dark-mode class on
 * `<html>`. Read-only, no entities / actions / events — purely UI state.
 *
 * `autoInstall: false` keeps the capability opt-in for now; once issue #121
 * deprecates the in-tree `useTheme` helper in `@linchkit/cap-adapter-ui` the
 * flag will flip and the provider will be mounted by the host shell.
 *
 * Issue: #121
 * Spec: 14 (System Capabilities)
 */

import { defineCapability } from "@linchkit/core";

export const capTheme = defineCapability({
  name: "cap-theme",
  label: "Theme",
  description: "System / light / dark mode toggle with localStorage persistence.",
  type: "standard",
  category: "system",
  version: "0.1.0",
  group: "theme",
  dependencies: ["cap-adapter-ui"],
  autoInstall: false,
});
