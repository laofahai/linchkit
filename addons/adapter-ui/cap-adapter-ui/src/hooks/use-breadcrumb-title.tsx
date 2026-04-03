/**
 * Context for pages to provide a custom title to the breadcrumb.
 *
 * The shell layout wraps content in BreadcrumbTitleProvider.
 * Pages (e.g. SchemaFormPage) call `setBreadcrumbTitle("Order #123")`
 * and the breadcrumb hook reads it to display a meaningful label
 * instead of a raw UUID segment.
 */

import { createContext, type ReactNode, useCallback, useContext, useState } from "react";

interface BreadcrumbTitleContextValue {
  /** Current custom title for the deepest breadcrumb segment */
  title: string | null;
  /** Set (or clear) the custom breadcrumb title */
  setBreadcrumbTitle: (title: string | null) => void;
}

const BreadcrumbTitleContext = createContext<BreadcrumbTitleContextValue>({
  title: null,
  setBreadcrumbTitle: () => {},
});

export function BreadcrumbTitleProvider({ children }: { children: ReactNode }) {
  const [title, setTitle] = useState<string | null>(null);

  const setBreadcrumbTitle = useCallback((t: string | null) => {
    setTitle(t);
  }, []);

  return (
    <BreadcrumbTitleContext.Provider value={{ title, setBreadcrumbTitle }}>
      {children}
    </BreadcrumbTitleContext.Provider>
  );
}

/** Read the current breadcrumb title (used by the breadcrumb hook) */
export function useBreadcrumbTitle() {
  return useContext(BreadcrumbTitleContext);
}
