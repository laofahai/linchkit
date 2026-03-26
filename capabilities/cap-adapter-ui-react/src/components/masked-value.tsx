/**
 * MaskedValue — Visual indicator for data-masked field values.
 *
 * Wraps masked text with a lock icon and tooltip explaining
 * that the field is masked for privacy/security.
 */

import { Badge, Tooltip, TooltipContent, TooltipTrigger } from "@linchkit/ui-kit/components";
import { LockIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isFullyMasked } from "@/lib/masking";

interface MaskedValueProps {
  /** The masked string value */
  value: string;
  /** Optional className for outer wrapper */
  className?: string;
}

export function MaskedValue({ value, className }: MaskedValueProps) {
  const { t } = useTranslation();
  const fullyMasked = isFullyMasked(value);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={`inline-flex items-center gap-1 ${className ?? ""}`}>
          <LockIcon className="size-3 text-muted-foreground shrink-0" />
          {fullyMasked ? (
            <Badge variant="secondary" className="text-xs font-normal px-1.5 py-0">
              {value}
            </Badge>
          ) : (
            <span className="text-muted-foreground">{value}</span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent>{t("masking.tooltip")}</TooltipContent>
    </Tooltip>
  );
}
