/**
 * Dynamic Lucide icon resolver.
 *
 * Maps a Lucide icon name string (e.g. "ShoppingCart") to the corresponding
 * React component from lucide-react. Returns a fallback icon when the name
 * is not recognized.
 */

import { icons, type LucideProps } from "lucide-react";

/** Resolve a Lucide icon name to a component. Returns null if not found. */
export function getLucideIcon(name: string | undefined): React.FC<LucideProps> | null {
  if (!name) return null;
  // lucide-react exports icons keyed by PascalCase name (e.g. "ShoppingCart")
  const Icon = icons[name as keyof typeof icons];
  return Icon ?? null;
}
