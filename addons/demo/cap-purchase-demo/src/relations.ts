/**
 * Link definitions for purchase-demo capability
 *
 * Defines relationships between purchase-related schemas.
 */

import { defineRelation } from "@linchkit/core";

/** Purchase request belongs to a department (many_to_one) */
export const requestToDepartment = defineRelation({
  name: "request_to_department",
  from: "purchase_request",
  to: "department",
  cardinality: "many_to_one",
  fromName: "department",
  toName: "purchase_requests",
  label: { from: "Department", to: "Purchase Requests" },
});

/** Purchase request has many items (one_to_many, cascade delete) */
export const requestToItems = defineRelation({
  name: "request_to_items",
  from: "purchase_request",
  to: "purchase_item",
  cardinality: "one_to_many",
  fromName: "items",
  toName: "purchase_request",
  cascade: "delete",
  label: { from: "Items", to: "Purchase Request" },
});
