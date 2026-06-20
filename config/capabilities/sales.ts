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
 *   - `extendEntity("partner", …)` appends a `credit_limit` field to the entity,
 *     plus an `is_late_payer` flag that drives the credit-policy enforcement rule.
 *   - `extendView("partner_form", …)` appends `credit_limit` to the form view.
 *
 * Both are folded into the base definitions during boot assembly
 * (`extractCapabilities` → `applyEntityExtensions`/`applyViewExtensions`), so
 * every downstream consumer (GraphQL schema, CRUD, runtime registry, the
 * rendered form) sees the merged shape.
 *
 * cap-sales also OWNS the enforcement rule (Build B, PR2): because it is the
 * capability that injected the credit fields, it carries the rule that governs
 * raising them. The rule is registered explicitly on the `rules: [...]` array
 * (there is no auto-glob — registration is by reference, exactly as
 * cap-purchase-demo registers its manager-approval rule).
 */

import { defineCapability, extendEntity, extendView } from "@linchkit/core";
import { latePayerCreditRaiseRule } from "./credit-policy.rule";

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
  // The credit-policy rule that gates raising a late payer's credit limit.
  // Registered by reference (no auto-glob); the action engine evaluates it on
  // every `update_partner` execution via the real rule-in-action wiring.
  rules: [latePayerCreditRaiseRule],
  extensions: {
    entities: [
      extendEntity("partner", {
        fields: {
          credit_limit: { type: "number", label: "Credit Limit" },
          // Human-set "late payer" signal that drives the credit-policy rule.
          // Defaults to false: a partner is in good standing until flagged.
          is_late_payer: {
            type: "boolean",
            label: "Late Payer",
            default: false,
          },
        },
      }),
    ],
    views: [extendView("partner_form", { addFields: [{ field: "credit_limit" }] })],
  },
});
