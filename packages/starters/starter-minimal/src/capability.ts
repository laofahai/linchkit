/**
 * @linchkit/starter-minimal capability definition
 *
 * A minimal starter pack (Spec 14). Declaring this capability in a project's
 * `linchkit.config.ts` pulls in the baseline auth + permission stack via the
 * capability dependency resolver — `resolveCapabilities` walks `dependencies`
 * and activates the listed caps from the discovered addons pool.
 *
 * `dependencies` references capabilities by their DEFINITION name (the `name`
 * field passed to `defineCapability`), not by npm package name:
 *   - "cap-auth"       — addons/auth/cap-auth
 *   - "cap-permission" — addons/permission/cap-permission
 */

import type { CapabilityDefinition } from "@linchkit/core";
import { defineCapability } from "@linchkit/core";

export const starterMinimal: CapabilityDefinition = defineCapability({
  name: "starter-minimal",
  label: "Minimal Starter",
  description: "Baseline starter pack that activates the auth + permission stack.",
  type: "standard",
  category: "system",
  version: "0.1.0",
  dependencies: ["cap-auth", "cap-permission"],
});
