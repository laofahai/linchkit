/**
 * cap-partner — base capability for the in-place extension demo.
 *
 * Reference/demo module (NOT an npm workspace package). It is authored as a
 * plain TypeScript module so `config/linchkit.config.ts` can import it via a
 * relative path: the worktree's `node_modules` is a symlink to the main
 * checkout, so a brand-new `addons/*` workspace package would not resolve here.
 * Promotable to a real `addons/partner/cap-partner` package later.
 *
 * It defines the `partner` entity plus a `partner_form` (form) and a
 * `partner_list` (list) view. The form view deliberately has NO explicit
 * `layout` so it renders straight from `fields[]` — that way a field appended
 * by an extension capability (see ./sales.ts) automatically surfaces in the
 * rendered form. This is the LinchKit analogue of Odoo's `_inherit` model.
 */

import { defineCapability, defineView, type EntityDefinition } from "@linchkit/core";

// ── Entity ───────────────────────────────────────────────────────────────────

const partnerEntity: EntityDefinition = {
  name: "partner",
  label: "Partner",
  description: "A business contact — a person or a company",
  presentation: {
    titleField: "name",
    summaryFields: ["email", "phone"],
    icon: "users",
  },
  fields: {
    name: { type: "string", required: true, label: "Name", ui: { importance: "primary" } },
    email: { type: "string", label: "Email" },
    phone: { type: "string", label: "Phone" },
    is_company: { type: "boolean", label: "Is Company" },
  },
};

// ── Views ──────────────────────────────────────────────────────────────────

// No explicit `layout` — the form renders from `fields[]`, so an appended
// extension field (credit_limit) surfaces without forking this view.
const partnerFormView = defineView({
  name: "partner_form",
  entity: "partner",
  type: "form",
  label: "Partner",
  fields: [{ field: "name" }, { field: "email" }, { field: "phone" }, { field: "is_company" }],
});

const partnerListView = defineView({
  name: "partner_list",
  entity: "partner",
  type: "list",
  label: "Partners",
  fields: [
    { field: "name", sortable: true },
    { field: "email", sortable: true },
  ],
});

// ── Capability ───────────────────────────────────────────────────────────────

export const partnerCapability = defineCapability({
  name: "cap-partner",
  label: "Partner",
  description: "Base partner directory: the `partner` entity plus its form/list views",
  type: "standard",
  category: "business",
  version: "0.1.0",
  entities: [partnerEntity],
  views: [partnerFormView, partnerListView],
});
