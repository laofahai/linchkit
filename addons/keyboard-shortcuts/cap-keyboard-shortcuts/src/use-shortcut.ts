/**
 * `useShortcut(...)` — register a single shortcut for the lifetime of a
 * component. Internally calls `registry.register` on mount and
 * `registry.unregister` on cleanup. Re-registers when the `keys`,
 * `scope`, `description`, or `allowInInput` change so the latest config
 * is always live; the handler / `when` predicate are read through a ref
 * so callers don't need to memoize them.
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

  useEffect(() => {
    const id = registry.register({
      keys: options.keys,
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
  }, [registry, options.keys, options.scope, options.description, options.allowInInput]);
}
