/**
 * ErrorBoundary — catches render errors in its subtree and shows a fallback
 * instead of white-screening the whole SPA.
 *
 * React only supports error catching via a class component
 * (`getDerivedStateFromError` + `componentDidCatch`), so this is intentionally
 * a class. The default fallback is a small i18n-friendly panel built from
 * ui-kit primitives with a Retry button that resets the boundary.
 *
 * Happy-path behavior is unchanged: a boundary only renders the fallback once a
 * child throws during render.
 */

import { Alert, AlertDescription, AlertTitle, Button } from "@linchkit/ui-kit/components";
import { AlertTriangleIcon } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

/** A render function fallback receives the caught error and a reset callback. */
export type ErrorBoundaryFallbackRender = (error: Error, reset: () => void) => ReactNode;

export interface ErrorBoundaryProps {
  /**
   * Fallback UI when a child throws. Either a static node, or a render function
   * receiving the error and a `reset` callback to clear the boundary state.
   * Omitted → the built-in `DefaultErrorFallback` panel is used.
   */
  fallback?: ReactNode | ErrorBoundaryFallbackRender;
  /** Called when the boundary is reset (Retry). Use to re-trigger data loads. */
  onReset?: () => void;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Default fallback panel. Kept as its own function component so it can use
 * hooks (`useTranslation`) — the ErrorBoundary class itself cannot.
 */
function DefaultErrorFallback({ error, reset }: { error: Error; reset: () => void }) {
  const { t } = useTranslation();

  return (
    <div className="flex w-full items-center justify-center p-6">
      <Alert variant="destructive" className="max-w-md">
        <AlertTriangleIcon />
        <AlertTitle>{t("errors.boundaryTitle", "Something went wrong")}</AlertTitle>
        <AlertDescription>
          <p>
            {t(
              "errors.boundaryDescription",
              "An unexpected error occurred while rendering this view.",
            )}
          </p>
          {error.message ? (
            <p className="text-muted-foreground text-xs break-words">{error.message}</p>
          ) : null}
          <Button variant="outline" size="sm" className="mt-2" onClick={reset}>
            {t("common.retry", "Retry")}
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  );
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    // React can surface non-Error throws (strings, plain objects, null).
    // Normalize so the fallback can always safely read `error.message`.
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Match the client logging convention used across src/components.
    console.error("[ErrorBoundary] Render error:", error, info.componentStack);
  }

  private readonly reset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render(): ReactNode {
    const { error } = this.state;
    const { fallback, children } = this.props;

    if (error) {
      if (typeof fallback === "function") {
        return fallback(error, this.reset);
      }
      if (fallback !== undefined) {
        return fallback;
      }
      return <DefaultErrorFallback error={error} reset={this.reset} />;
    }

    return children;
  }
}
