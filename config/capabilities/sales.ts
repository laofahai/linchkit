/**
 * cap-sales — extension (bridge) capability for the in-place extension demo.
 *
 * Reference/demo module (NOT an npm workspace package). Authored as a plain
 * TypeScript module so `config/linchkit.config.ts` can import it via a relative
 * path (the worktree's symlinked `node_modules` would not resolve a brand-new
 * `addons/*` workspace package). Promotable to a real
 * `addons/sales/cap-sales` package later.
 *
 * This is the payload of the demo: a SEPARATE capability that patches
 * cap-partner's `partner` entity and `partner_form` view IN PLACE — the Odoo
 * `_inherit` model — WITHOUT forking cap-partner:
 *
 *   - `extendEntity("partner", …)` appends a `credit_limit` field to the entity.
 *   - `extendView("partner_form", …)` appends `credit_limit` to the form view.
 *
 * Both are folded into the base definitions during boot assembly
 * (`extractCapabilities` → `applyEntityExtensions`/`applyViewExtensions`), so
 * every downstream consumer (GraphQL schema, CRUD, runtime registry, the
 * rendered form) sees the merged shape.
 */

import { defineCapability, extendEntity, extendView } from "@linchkit/core";

export const salesCapability = defineCapability({
  name: "cap-sales",
  label: "Sales",
  description:
    "Adds a credit limit to partners in place (extends cap-partner's `partner` " +
    "entity + `partner_form` view) without forking the base capability",
  type: "bridge",
  category: "business",
  version: "0.1.0",
  group: "partner",
  dependencies: ["cap-partner"],
  autoInstall: true,
  extensions: {
    entities: [
      extendEntity("partner", {
        fields: { credit_limit: { type: "number", label: "Credit Limit" } },
      }),
    ],
    views: [extendView("partner_form", { addFields: [{ field: "credit_limit" }] })],
  },
});
