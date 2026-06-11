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
 * when no real auth capability is active (`isAuthEnabled()` from
 * /api/app-config) — with real auth, identities come from login, not headers.
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
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { isAuthEnabled } from "@/lib/api";
import { DEV_ROLES, type DevRole, getDevRole, setDevRole } from "@/lib/dev-role";

export function DevRoleSwitcher() {
  const { t } = useTranslation();
  const activeRole = getDevRole();

  const handleSelect = useCallback((role: DevRole) => {
    setDevRole(role);
    // Reload so every page refetches with the new role context — same
    // strategy as TenantSwitcher.
    window.location.reload();
  }, []);

  // Dev builds only (statically eliminated in production), and never when a
  // real auth capability provides actual identities.
  if (!import.meta.env.DEV || isAuthEnabled()) return null;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-muted-foreground">
              <UserCogIcon className="size-4" />
              <span className="hidden text-xs sm:inline-flex max-w-[120px] truncate">
                {t(`devRole.roles.${activeRole}`)}
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
