/**
 * DevRoleSwitcher — dev-only dropdown to walk the app as different roles.
 *
 * DEVELOPMENT AFFORDANCE, NOT AN AUTH MECHANISM. Persists the choice to
 * localStorage (`linchkit:dev-role`); `getAuthHeaders()` then attaches it as
 * the `x-dev-role` header, which the no-auth dev server's actor resolver maps
 * to a demo actor (user / manager / admin). Mirrors TenantSwitcher's style
 * and reload-on-change behavior.
 *
 * Visibility: rendered only in Vite dev builds (`import.meta.env.DEV` is
 * statically replaced, so production builds tree-shake this out) AND only
 * once /api/app-config has resolved with `authEnabled: false` (fail-closed:
 * hidden until resolved) — with real auth, identities come from login, not
 * headers.
 */

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@linchkit/ui-kit/components";
import { CheckIcon, UserCogIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchAppConfig } from "@/lib/api";
import { DEV_ROLES, type DevRole, getStoredDevRole, setDevRole } from "@/lib/dev-role";

/**
 * Resolve `authEnabled` from the (cached) app-config fetch reactively.
 * The module-level cache behind `isAuthEnabled()` is null until the first
 * fetch resolves, and React gets no re-render signal when it does — a plain
 * synchronous read here would return false on first render even when auth is
 * enabled. Tri-state: null = not resolved yet (FAIL-CLOSED: treat as "may be
 * enabled" and render nothing).
 */
function useAuthEnabled(): boolean | null {
  const [authEnabled, setAuthEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Reuses the cached fetch — resolves instantly after the app shell loaded.
    fetchAppConfig().then((config) => {
      if (!cancelled) setAuthEnabled(config.authEnabled);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return authEnabled;
}

export function DevRoleSwitcher() {
  const { t } = useTranslation();
  const authEnabled = useAuthEnabled();
  // The STORED choice (null when none): with no choice, NO header is sent and
  // the server resolves the anonymous no-auth default — which is NOT the same
  // actor as an explicit "admin" selection. Displaying "Admin" there would
  // claim an identity the server isn't using, so the trigger shows a distinct
  // "Default" label and no role gets a check mark until one is chosen.
  const activeRole = getStoredDevRole();

  const handleSelect = useCallback((role: DevRole | null) => {
    // null clears the stored choice → back to the "Default (anonymous)" state
    // (no header sent). Reload so every page refetches with the new role
    // context — same strategy as TenantSwitcher.
    setDevRole(role);
    window.location.reload();
  }, []);

  // Dev builds only (statically eliminated in production), and never when a
  // real auth capability provides actual identities. FAIL-CLOSED: stays
  // hidden until the app config has resolved to authEnabled === false.
  if (!import.meta.env.DEV || authEnabled !== false) return null;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-muted-foreground">
              <UserCogIcon className="size-4" />
              <span className="hidden text-xs sm:inline-flex max-w-[120px] truncate">
                {activeRole ? t(`devRole.roles.${activeRole}`) : t("devRole.roles.default")}
              </span>
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{t("devRole.switchRole")}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-[180px]">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {t("devRole.selectRole")}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {/* "Default (anonymous)" clears the stored choice — without it a user
            could never return to the no-header state from the UI. */}
        <DropdownMenuItem onClick={() => handleSelect(null)} className="gap-2">
          <UserCogIcon className="size-4 text-muted-foreground" />
          <span className="flex-1">{t("devRole.roles.default")}</span>
          {activeRole === null && <CheckIcon className="size-4 text-primary" />}
        </DropdownMenuItem>
        {DEV_ROLES.map((role) => (
          <DropdownMenuItem key={role} onClick={() => handleSelect(role)} className="gap-2">
            <UserCogIcon className="size-4 text-muted-foreground" />
            <span className="flex-1">{t(`devRole.roles.${role}`)}</span>
            {role === activeRole && <CheckIcon className="size-4 text-primary" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5 text-[10px] leading-tight text-muted-foreground">
          {t("devRole.devOnlyHint")}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
