/**
 * `useShortcut(...)` — register a single shortcut for the lifetime of a
 * component. Internally calls `registry.register` on mount and
 * `registry.unregister` on cleanup. Re-registers when the `keys`,
 * `scope`, `description`, or `allowInInput` change so the latest config
 * is always live; the handler / `when` predicate are read through a ref
 * so callers don't need to memoize them.
 *
 * Conditional registration: pass `keys: null` (or omit it / pass
 * `undefined`) to skip registration entirely. The hook still runs all
 * its React calls in a stable order — only the registry side-effect is
 * gated. This lets callers like `<ShortcutCheatsheet>` accept an opt-out
 * trigger without inventing an "unreachable" placeholder key.
 */

import { useEffect, useRef } from "react";
import { useShortcutRegistry } from "./ShortcutProvider";
import type { ShortcutOptions } from "./types";

export function useShortcut(options: ShortcutOptions): void {
  const registry = useShortcutRegistry();
  const handlerRef = useRef(options.handler);
  const whenRef = useRef(options.when);

  // Keep the refs current without invalidating the registration effect.
  useEffect(() => {
    handlerRef.current = options.handler;
    whenRef.current = options.when;
  }, [options.handler, options.when]);

  // `keys` may be null/undefined to disable registration. Normalize to
  // empty so the effect dep array stays a primitive and React doesn't
  // see `undefined` swing back-and-forth.
  const keys = options.keys ?? "";

  useEffect(() => {
    if (!keys) return;
    const id = registry.register({
      keys,
      scope: options.scope,
      description: options.description,
      allowInInput: options.allowInInput,
      handler: (event) => handlerRef.current(event),
      when: () => {
        const predicate = whenRef.current;
        return predicate ? Boolean(predicate()) : true;
      },
    });
    return () => {
      registry.unregister(id);
    };
    // Deliberately exclude handler / when — they are read through refs.
  }, [registry, keys, options.scope, options.description, options.allowInInput]);
}
