/**
 * TenantSwitcher — Dropdown to switch the active tenant context.
 *
 * Reads tenant list from app config or a default set.
 * Persists selection to localStorage and reloads data on change.
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
import { Building2Icon, CheckIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type TenantInfo, getActiveTenantId, setActiveTenantId } from "@/lib/tenant";

interface TenantSwitcherProps {
  /** Optional list of tenants. If not provided, fetches from /api/tenants. */
  tenants?: TenantInfo[];
}

export function TenantSwitcher({ tenants: propTenants }: TenantSwitcherProps) {
  const { t } = useTranslation();
  const [tenants, setTenants] = useState<TenantInfo[]>(propTenants ?? []);
  const [activeTenantId, setActiveTenant] = useState<string | null>(getActiveTenantId);

  // Fetch tenant list from server if not provided via props
  useEffect(() => {
    if (propTenants) return;

    let cancelled = false;
    fetch("/api/tenants")
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!cancelled && json?.data) {
          setTenants(json.data as TenantInfo[]);
        }
      })
      .catch(() => {
        // Server may not support tenant listing — that's fine
      });
    return () => {
      cancelled = true;
    };
  }, [propTenants]);

  const handleSelect = useCallback(
    (tenantId: string | null) => {
      setActiveTenantId(tenantId);
      setActiveTenant(tenantId);
      // Reload page to refetch all data with new tenant context
      window.location.reload();
    },
    [],
  );

  // Don't render if no tenants are configured
  if (tenants.length === 0) return null;

  const activeTenant = tenants.find((t) => t.id === activeTenantId);

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-muted-foreground">
              <Building2Icon className="size-4" />
              <span className="hidden text-xs sm:inline-flex max-w-[120px] truncate">
                {activeTenant?.name ?? t("tenant.noTenant")}
              </span>
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{t("tenant.switchTenant")}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-[180px]">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {t("tenant.selectTenant")}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {tenants.map((tenant) => (
          <DropdownMenuItem
            key={tenant.id}
            onClick={() => handleSelect(tenant.id)}
            className="gap-2"
          >
            <Building2Icon className="size-4 text-muted-foreground" />
            <span className="flex-1">{tenant.name}</span>
            {tenant.id === activeTenantId && (
              <CheckIcon className="size-4 text-primary" />
            )}
          </DropdownMenuItem>
        ))}
        {activeTenantId && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => handleSelect(null)}
              className="text-muted-foreground"
            >
              {t("tenant.clearTenant")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
