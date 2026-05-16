/**
 * Capability definition for cap-keyboard-shortcuts.
 *
 * Provides a React-side keyboard-shortcut registry plus a cheatsheet
 * overlay. The capability itself contributes nothing to the runtime
 * pipeline — its surface is component / hook based — but we still ship a
 * `defineCapability` shape so it can be activated through the standard
 * addon mechanism and so its i18n bundles register into the host's
 * react-i18next instance automatically.
 *
 * Issue: #121
 * Spec: 14 (System Capabilities)
 */

import { defineCapability } from "@linchkit/core";
import en from "./i18n/locales/en.json";
import zhCN from "./i18n/locales/zh-CN.json";

export const capKeyboardShortcuts = defineCapability({
  name: "cap-keyboard-shortcuts",
  label: "Keyboard Shortcuts",
  description:
    "Global keyboard shortcut registry, useShortcut hook, and Shift+? cheatsheet overlay.",
  type: "standard",
  category: "system",
  version: "0.1.0",
  group: "keyboard-shortcuts",
  autoInstall: false,
  extensions: {
    i18n: {
      en,
      "zh-CN": zhCN,
    },
  },
});
