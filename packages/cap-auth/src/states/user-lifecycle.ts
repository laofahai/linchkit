/**
 * User lifecycle state machine
 *
 * States: active, disabled, locked
 * - active: normal operational state
 * - disabled: admin-disabled, cannot log in
 * - locked: auto-locked (too many failed attempts), can be unlocked
 */

import { defineState } from "@linchkit/core";

export const userLifecycleState = defineState({
  name: "user_lifecycle",
  schema: "user",
  field: "status",
  initial: "active",
  states: ["active", "disabled", "locked"],
  transitions: [
    { from: "active", to: "disabled", action: "disable_user" },
    { from: "active", to: "locked", action: "lock_user" },
    { from: "disabled", to: "active", action: "enable_user" },
    { from: "locked", to: "active", action: "unlock_user" },
  ],
  meta: {
    active: {
      label: "Active",
      color: "green",
      description: "User can log in and operate normally",
    },
    disabled: {
      label: "Disabled",
      color: "gray",
      description: "Admin-disabled account, cannot log in",
    },
    locked: {
      label: "Locked",
      color: "red",
      description: "Auto-locked due to failed login attempts",
    },
  },
});
