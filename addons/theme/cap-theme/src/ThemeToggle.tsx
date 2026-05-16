/**
 * <ThemeToggle /> — three-state cycle button.
 *
 * Renders a single button whose icon mirrors the current mode (Monitor for
 * system, Sun for light, Moon for dark). Clicking advances through
 * {@link THEME_CYCLE} (system → light → dark → system).
 *
 * Stays presentational: all state lives in {@link ThemeProvider}; this
 * component only reads {@link useTheme} and dispatches `setMode`. That keeps
 * the component testable as a plain function and lets host apps swap in their
 * own button styling without touching the storage / matchMedia logic.
 */

import { Monitor, Moon, Sun } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { useTranslation } from "react-i18next";
import { nextMode, THEME_CYCLE } from "./transitions";
import type { ThemeMode } from "./types";
import { useTheme } from "./use-theme";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

/**
 * Icon to render for each mode. Defined as a `Record` so TypeScript can
 * enforce exhaustiveness if the {@link ThemeMode} union ever grows.
 */
const MODE_ICONS: Record<ThemeMode, IconComponent> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

export interface ThemeToggleProps {
  /** Optional class applied to the root `<button>` — host UIs override styling. */
  className?: string;
}

export function ThemeToggle({ className }: ThemeToggleProps = {}) {
  const { mode, setMode } = useTheme();
  const { t } = useTranslation();

  const Icon = MODE_ICONS[mode];
  const modeLabel = t(`theme.toggle.modes.${mode}`);
  const tooltip = t("theme.toggle.tooltip", { mode: modeLabel });
  // Embed the active mode in the accessible name so screen readers announce
  // the current selection — bare `aria-label` would override the sr-only
  // child and leave assistive tech without the live value.
  const ariaLabel = t("theme.toggle.ariaLabel", { mode: modeLabel });

  const handleClick = () => {
    setMode(nextMode(mode));
  };

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={tooltip}
      data-mode={mode}
      onClick={handleClick}
      className={className}
    >
      <Icon aria-hidden className="size-4" />
      <span className="sr-only">{modeLabel}</span>
    </button>
  );
}

// Re-export so consumers building a custom toggle can reuse the canonical cycle.
export { THEME_CYCLE };
