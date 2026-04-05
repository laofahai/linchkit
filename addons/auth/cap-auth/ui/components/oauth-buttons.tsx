/**
 * OAuthButtons — Configurable OAuth provider buttons.
 *
 * Renders a list of social/OAuth login buttons. The actual OAuth redirect
 * is handled by the callback — this component only renders the UI.
 */

import { Button, Separator } from "@linchkit/ui-kit/components";

export interface OAuthProvider {
  /** Provider identifier (e.g. "google", "github") */
  id: string;
  /** Display label (e.g. "Google", "GitHub") */
  label: string;
  /** Optional icon element */
  icon?: React.ReactNode;
}

export interface OAuthButtonsProps {
  /** List of OAuth providers to display */
  providers: OAuthProvider[];
  /** Called when a provider button is clicked */
  onProviderClick: (providerId: string) => void;
  /** Whether OAuth buttons are in loading state */
  loading?: boolean;
  /** Label for the divider between OAuth and form (default: "or") */
  dividerLabel?: string;
}

export function OAuthButtons({
  providers,
  onProviderClick,
  loading = false,
  dividerLabel = "or",
}: OAuthButtonsProps) {
  if (providers.length === 0) return null;

  return (
    <div className="space-y-3">
      {providers.map((provider) => (
        <Button
          key={provider.id}
          type="button"
          variant="outline"
          className="w-full"
          disabled={loading}
          onClick={() => onProviderClick(provider.id)}
        >
          {provider.icon && <span className="mr-2">{provider.icon}</span>}
          {provider.label}
        </Button>
      ))}
      <div className="relative flex items-center py-1">
        <Separator className="flex-1" />
        <span className="px-3 text-xs text-muted-foreground">{dividerLabel}</span>
        <Separator className="flex-1" />
      </div>
    </div>
  );
}
