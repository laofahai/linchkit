/**
 * Apply entity extensions to a set of entity definitions.
 *
 * This is the contribution-flattening counterpart to
 * `EntityRegistry.applyExtension`. A capability can declare
 * `extensions.entities` (the Odoo `_inherit` model) to add fields to ANOTHER
 * capability's entity in place. The registry's `resolve()` already merges stored
 * extensions, but several consumers read the RAW `entity.fields` (the GraphQL
 * schema builder, CRUD action generation, the `/api/entities/:name` endpoint).
 * Merging extension fields directly into the `EntityDefinition` objects at the
 * flattening stage makes the added field visible to ALL of those consumers,
 * not just the ones that go through `resolve()`.
 *
 * Pure and immutable: returns NEW entity objects with NEW `fields` maps; the
 * input entities are never mutated.
 *
 * Field-merge semantics are identical to `resolve()`: a brand-new field is added
 * as-is, while a field name that collides with an existing own field is merged
 * via {@link mergeFieldDefinition} (the extension field is the merge "child"),
 * so the Spec 63 constraint-key inheritance behaves the same on either path.
 *
 * OUT OF SCOPE: `entityOverrides` (constraint patches) are NOT applied here.
 * Overrides can target system fields that are only injected at `resolve()` time,
 * so wiring them at the raw-definition stage would mis-handle those. They remain
 * a resolve()-time concern.
 * TODO(entity-overrides-wiring): wire `extensions.entityOverrides` into a boot
 * path once a target consumer that reads raw fields needs them.
 */

import type { EntityDefinition, EntityExtension, FieldDefinition } from "../types/entity";
import { mergeFieldDefinition } from "./entity-registry";

/**
 * A single entity-extension input: which entity to extend, and with what fields.
 * This is exactly the shape produced by `extendEntity(target, extension)` and
 * stored in `cap.extensions.entities`. (Distinct from the richer
 * `EntityExtensionEntry` in the legacy ExtensionResolver, which also carries
 * `source`/`priority`.)
 */
export interface EntityExtensionInput {
  target: string;
  extension: EntityExtension;
}

/**
 * Merge entity extensions into a list of entity definitions.
 *
 * Each entry targets an entity by `name`. Multiple entries targeting the same
 * entity compose in array order. Throws if an entry targets an entity name that
 * is not present (fail-loud, mirrors `EntityRegistry.applyExtension`).
 */
export function applyEntityExtensions(
  entities: EntityDefinition[],
  extensions: EntityExtensionInput[],
): EntityDefinition[] {
  if (extensions.length === 0) {
    return [...entities];
  }

  // Shallow-clone every entity up front (new object + new fields map) so we
  // only ever mutate our copies, never the shared/frozen inputs.
  const cloned: EntityDefinition[] = entities.map((e) => ({
    ...e,
    fields: { ...e.fields },
  }));
  const byName = new Map(cloned.map((e) => [e.name, e]));

  for (const { target, extension } of extensions) {
    const entity = byName.get(target);
    if (!entity) {
      throw new Error(`Cannot extend unknown entity "${target}"`);
    }
    // `entity.fields` is our private clone; mutate it in place.
    const fields = entity.fields as Record<string, FieldDefinition>;
    for (const [fname, fdef] of Object.entries(extension.fields)) {
      const existing = fields[fname];
      fields[fname] = existing ? mergeFieldDefinition(existing, fdef) : fdef;
    }
  }

  return cloned;
}
