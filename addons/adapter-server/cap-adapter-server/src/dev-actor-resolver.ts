/**
 * Dev-only role-switching actor resolver (`x-dev-role` header).
 *
 * DEVELOPMENT AFFORDANCE, NOT AN AUTH MECHANISM. This resolver lets a live
 * demo walk the same app as different roles (purchase_user vs purchase_manager
 * vs admin) from every channel — browser UI, REST, MCP, AI agents — by sending
 * an `x-dev-role` header. It trusts the header blindly, so it must ONLY ever
 * be wired into the no-auth dev entry points (`dev.ts` / `createDevApp`),
 * never into `createServer` defaults and never alongside a real auth resolver
 * (when an auth capability configures `resolveRequestActor`, that resolver is
 * passed instead and this module stays out of the request path entirely).
 *
 * Contract:
 * - `x-dev-role: user`    → restricted purchase_user actor
 * - `x-dev-role: manager` → purchase_manager actor
 * - `x-dev-role: admin`   → elevated dev-admin actor
 * - absent / unrecognized → `NO_AUTH_ACTOR`, the SAME elevated default the
 *   no-auth dev server resolved before this module existed — existing REST
 *   scripts, flows, and AI endpoints keep working unchanged.
 *
 * The resolver always returns an Actor (never `undefined`) so the server's
 * `?? ANONYMOUS_ACTOR` fallback — which would DOWNGRADE privileges relative to
 * the historical no-resolver behavior — can never trigger on the dev path.
 */

import type { Actor } from "@linchkit/core";
import { NO_AUTH_ACTOR } from "./routes/shared";

/** Header carrying the requested dev role. Lowercase (HTTP headers are case-insensitive). */
export const DEV_ROLE_HEADER = "x-dev-role";

/**
 * Recognized dev roles and the synthetic actors they resolve to.
 *
 * Group sets are cumulative supersets (user ⊂ manager ⊂ admin) and include the
 * purchase-demo permission groups (`purchase_user` / `purchase_manager`) so
 * role-gated demo behavior ("only managers may approve large purchases") is
 * demonstrable out of the box.
 */
export const DEV_ROLE_ACTORS: Readonly<Record<string, Actor>> = Object.freeze({
  user: {
    type: "human",
    id: "dev-user",
    name: "Dev User",
    groups: ["purchase_user", "user"],
  },
  manager: {
    type: "human",
    id: "dev-manager",
    name: "Dev Manager",
    groups: ["purchase_manager", "manager", "user"],
  },
  admin: {
    type: "human",
    id: "dev-admin",
    name: "Dev Admin",
    groups: ["admin", "manager", "user"],
  },
});

/**
 * Resolve the request actor from the `x-dev-role` header (dev wiring only).
 *
 * Matching is case-insensitive and whitespace-tolerant. Absent or unrecognized
 * values fall back to the elevated {@link NO_AUTH_ACTOR} — identical to the
 * pre-existing no-resolver dev behavior, so this is strictly additive.
 */
export function resolveDevRoleActor(request: Request): Actor {
  const raw = request.headers.get(DEV_ROLE_HEADER);
  if (raw) {
    const actor = DEV_ROLE_ACTORS[raw.trim().toLowerCase()];
    if (actor) return actor;
  }
  // Back-compat: same elevated default as the historical no-resolver dev mode.
  return NO_AUTH_ACTOR;
}
