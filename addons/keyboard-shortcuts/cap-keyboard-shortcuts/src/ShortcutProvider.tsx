/**
 * `<ShortcutProvider>` — mounts a single global `keydown` listener and
 * exposes the per-tree {@link ShortcutRegistry} via React context so child
 * components can register shortcuts via {@link useShortcut}.
 *
 * Editable-target bail-out lives here (not in the registry) because the
 * registry is DOM-agnostic. We mirror the pattern that landed for the
 * global search shortcut in PR #319 (`GlobalSearchInput.tsx`): when the
 * keydown's `target` is an `INPUT`, `TEXTAREA`, `SELECT`, or a
 * `contentEditable` element, we skip the dispatch — unless the matched
 * shortcut opts in via `allowInInput: true`.
 *
 * The provider intentionally creates the registry once via `useState`'s
 * lazy initializer so StrictMode double-renders don't churn it.
 */

import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { type RegistryOptions, ShortcutRegistry } from "./shortcut-registry";

const ShortcutContext = createContext<ShortcutRegistry | null>(null);

export interface ShortcutProviderProps {
  children: ReactNode;
  /** Optional registry options forwarded to the {@link ShortcutRegistry}. */
  options?: RegistryOptions;
  /**
   * Element to attach the keydown listener to. Defaults to `window`.
   * Tests inject a fake target so we don't need a real DOM.
   */
  target?: EventTarget;
}

export function ShortcutProvider(props: ShortcutProviderProps) {
  const { children, options, target } = props;
  // Lazy init so the registry survives StrictMode re-renders.
  const [registry] = useState(() => new ShortcutRegistry(options));

  useEffect(() => {
    const listenTarget: EventTarget | undefined =
      target ?? (typeof window === "undefined" ? undefined : window);
    if (!listenTarget) return;

    function handleKeydown(event: Event) {
      const keyEvent = event as KeyboardEvent;
      const editable = isEditableTarget(keyEvent);
      const handled = registry.dispatch({ event: keyEvent, isEditableTarget: editable });
      if (handled && typeof keyEvent.preventDefault === "function") {
        keyEvent.preventDefault();
      }
    }

    listenTarget.addEventListener("keydown", handleKeydown);
    return () => {
      listenTarget.removeEventListener("keydown", handleKeydown);
    };
  }, [registry, target]);

  return <ShortcutContext.Provider value={registry}>{children}</ShortcutContext.Provider>;
}

/**
 * Read the registry from context. Throws when called outside a provider —
 * loud failure beats silent no-op when a `useShortcut` call is misplaced.
 */
export function useShortcutRegistry(): ShortcutRegistry {
  const registry = useContext(ShortcutContext);
  if (!registry) {
    throw new Error(
      "cap-keyboard-shortcuts: useShortcut / useShortcutRegistry called outside a <ShortcutProvider>",
    );
  }
  return registry;
}

/**
 * Decide whether a keydown event originated inside an editable element.
 * Mirrors the heuristic used by cap-search-ui's global search input.
 */
function isEditableTarget(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (!target) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}
