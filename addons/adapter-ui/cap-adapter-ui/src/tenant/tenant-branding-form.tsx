/**
 * TenantBrandingForm — edit the tenant's app name, logo URL and primary colour.
 *
 * Controlled form: parent owns the initial value via `value` and is notified
 * when the user clicks Save. Local state holds the in-progress edits so
 * the user can revert without disturbing the persisted snapshot.
 */

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from "@linchkit/ui-kit/components";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { isValidHexColor } from "./tenant-helpers";
import type { TenantBranding } from "./tenant-self-service-types";

export interface TenantBrandingFormProps {
  value: TenantBranding;
  onSave: (next: TenantBranding) => Promise<void> | void;
  disabled?: boolean;
}

export function TenantBrandingForm({ value, onSave, disabled }: TenantBrandingFormProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<TenantBranding>(value);
  const [saving, setSaving] = useState(false);

  // Sync local draft when parent loads fresh data.
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const colorValid = isValidHexColor(draft.primaryColor);
  const dirty =
    draft.appName !== value.appName ||
    draft.logoUrl !== value.logoUrl ||
    draft.primaryColor !== value.primaryColor;
  const canSave = !disabled && !saving && dirty && draft.appName.trim().length > 0 && colorValid;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      await onSave({ ...draft, appName: draft.appName.trim(), logoUrl: draft.logoUrl.trim() });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("tenant.branding.title", "Branding")}</CardTitle>
        <CardDescription>
          {t("tenant.branding.description", "Customise how this tenant appears to its members.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="tenant-app-name">{t("tenant.branding.appName", "App name")}</Label>
          <Input
            id="tenant-app-name"
            value={draft.appName}
            disabled={disabled}
            onChange={(e) => setDraft((d) => ({ ...d, appName: e.target.value }))}
            placeholder={t("tenant.branding.appNamePlaceholder", "e.g. Acme Workspace")}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="tenant-logo-url">{t("tenant.branding.logoUrl", "Logo URL")}</Label>
          <Input
            id="tenant-logo-url"
            value={draft.logoUrl}
            disabled={disabled}
            onChange={(e) => setDraft((d) => ({ ...d, logoUrl: e.target.value }))}
            placeholder="https://cdn.example.com/logo.svg"
          />
          {draft.logoUrl && (
            <div className="mt-2 flex items-center gap-3 rounded-md border p-3">
              <img
                src={draft.logoUrl}
                alt={t("tenant.branding.logoPreviewAlt", "Logo preview")}
                className="h-10 w-10 rounded object-contain"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
                }}
              />
              <span className="text-xs text-muted-foreground">
                {t("tenant.branding.logoPreview", "Logo preview")}
              </span>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="tenant-primary-color">
            {t("tenant.branding.primaryColor", "Primary color")}
          </Label>
          <div className="flex items-center gap-3">
            <Input
              id="tenant-primary-color"
              value={draft.primaryColor}
              disabled={disabled}
              onChange={(e) => setDraft((d) => ({ ...d, primaryColor: e.target.value }))}
              placeholder="#2563eb"
              className="font-mono"
            />
            <span
              aria-hidden="true"
              className="h-9 w-9 shrink-0 rounded-md border"
              style={{ backgroundColor: colorValid ? draft.primaryColor : "transparent" }}
            />
          </div>
          {!colorValid && draft.primaryColor.length > 0 && (
            <p className="text-xs text-destructive">
              {t("tenant.branding.invalidColor", "Enter a valid hex color, e.g. #2563eb.")}
            </p>
          )}
        </div>

        <div className="flex justify-end pt-2">
          <Button onClick={handleSave} disabled={!canSave}>
            {saving
              ? t("tenant.branding.saving", "Saving...")
              : t("tenant.branding.save", "Save branding")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
