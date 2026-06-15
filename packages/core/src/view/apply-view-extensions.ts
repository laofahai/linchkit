/**
 * Apply view extensions to a set of view definitions.
 *
 * This is the boot-path counterpart to `EntityRegistry.applyExtension` for
 * views: a capability can declare `extensions.views` (the Odoo view-inheritance
 * model) to patch ANOTHER capability's view — add/remove/override fields and
 * add/remove action buttons. Until this function is wired into the boot paths
 * those declarations are dead data.
 *
 * Pure and immutable: returns a NEW array of NEW view objects; the input views
 * (which may be frozen or shared across consumers) are never mutated.
 *
 * LIMITATION (layout-aware insertion): `addFields` only appends to the view's
 * flat `fields[]` array. It does NOT splice the new field into a form's
 * `layout.nodes` tree (Odoo xpath-style positioned insertion). A form view that
 * renders strictly from `layout.nodes` will therefore not surface an appended
 * field automatically — only views that render from `fields[]` (or whose layout
 * is derived from `fields[]`) will. Positioned layout insertion is deferred.
 * TODO(layout-xpath): support positioned insertion into FormLayout.nodes.
 */

import type { ViewAction, ViewDefinition, ViewExtension, ViewFieldConfig } from "../types/view";

/**
 * A single view-extension input: which view to patch, and how. This is exactly
 * the shape produced by `extendView(target, extension)` and stored in
 * `cap.extensions.views`.
 */
export interface ViewExtensionInput {
  target: string;
  extension: ViewExtension;
}

/**
 * Apply one extension to a single (already shallow-cloned) view, mutating the
 * clone's `fields`/`actions` arrays in place. The clone is owned by the caller,
 * so in-place mutation here does not leak to the original input.
 */
function applyOneExtension(view: ViewDefinition, extension: ViewExtension): void {
  // 1. removeFields — drop matching field configs.
  if (extension.removeFields && extension.removeFields.length > 0) {
    const remove = new Set(extension.removeFields);
    view.fields = view.fields.filter((cfg) => !remove.has(cfg.field));
  }

  // 2. overrideFields — shallow-merge a partial config onto a matching field.
  if (extension.overrideFields) {
    const overrides = extension.overrideFields;
    view.fields = view.fields.map((cfg) =>
      Object.hasOwn(overrides, cfg.field) ? { ...cfg, ...overrides[cfg.field] } : cfg,
    );
  }

  // 3. addFields — append; fail loud on a duplicate (post-remove) field name.
  if (extension.addFields && extension.addFields.length > 0) {
    const existing = new Set(view.fields.map((cfg) => cfg.field));
    const added: ViewFieldConfig[] = [];
    for (const cfg of extension.addFields) {
      if (existing.has(cfg.field)) {
        throw new Error(
          `View "${view.name}": field "${cfg.field}" already exists; use overrideFields`,
        );
      }
      existing.add(cfg.field);
      added.push({ ...cfg });
    }
    view.fields = [...view.fields, ...added];
  }

  // 4. removeActions, then addActions.
  if (extension.removeActions && extension.removeActions.length > 0) {
    const remove = new Set(extension.removeActions);
    view.actions = (view.actions ?? []).filter((a) => !remove.has(a.action));
  }
  if (extension.addActions && extension.addActions.length > 0) {
    const existingActions = new Set((view.actions ?? []).map((a) => a.action));
    const added: ViewAction[] = [];
    for (const action of extension.addActions) {
      if (existingActions.has(action.action)) {
        throw new Error(`View "${view.name}": action "${action.action}" already exists`);
      }
      existingActions.add(action.action);
      added.push({ ...action });
    }
    view.actions = [...(view.actions ?? []), ...added];
  }
}

/**
 * Merge view extensions into a list of view definitions.
 *
 * Each entry targets a view by `name`. Multiple entries targeting the same view
 * compose in array order. Within one extension the patch order is:
 * removeFields → overrideFields → addFields → removeActions → addActions.
 *
 * Throws if an entry targets a view name that is not present (fail-loud, mirrors
 * `EntityRegistry.applyExtension` and the duplicate-flow guard in
 * `assemble-schema.ts`).
 */
export function applyViewExtensions(
  views: ViewDefinition[],
  extensions: ViewExtensionInput[],
): ViewDefinition[] {
  if (extensions.length === 0) {
    // Still return new objects so callers cannot rely on identity, but avoid
    // cloning when there is no work to do.
    return [...views];
  }

  // Shallow-clone every view up front (new objects + new fields/actions arrays)
  // so extensions mutate only our copies, never the shared/frozen inputs.
  const cloned = views.map((v) => ({
    ...v,
    fields: [...v.fields],
    actions: v.actions ? [...v.actions] : undefined,
  }));
  const byName = new Map(cloned.map((v) => [v.name, v]));

  for (const { target, extension } of extensions) {
    const view = byName.get(target);
    if (!view) {
      throw new Error(`Cannot extend unknown view "${target}"`);
    }
    applyOneExtension(view, extension);
  }

  return cloned;
}
