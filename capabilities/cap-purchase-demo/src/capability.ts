/**
 * cap-purchase-demo capability definition
 *
 * Demo purchase request capability showcasing schema, actions,
 * state machine, views, and seed data.
 */

import { defineCapability } from "@linchkit/core";
import { approveAction } from "./actions/approve";
import { submitAction } from "./actions/submit";
import { requestToDepartment, requestToItems } from "./links";
import { departmentSchema } from "./schemas/department";
import { purchaseItemSchema } from "./schemas/purchase-item";
import { purchaseRequestSchema } from "./schemas/purchase-request";
import {
  departmentSeedData,
  purchaseItemSeedData,
  purchaseRequestSeedData,
} from "./seed";
import { purchaseRequestState } from "./states/purchase-request";
import { purchaseRequestFormView } from "./views/form";
import { purchaseRequestListView } from "./views/list";

export const capPurchaseDemo = defineCapability({
  name: "cap-purchase-demo",
  label: "Purchase Request Demo",
  description: "Demo purchase request capability with approval workflow",
  type: "standard",
  category: "business",
  version: "0.0.1",

  schemas: [purchaseRequestSchema, departmentSchema, purchaseItemSchema],
  actions: [submitAction, approveAction],
  states: [purchaseRequestState],
  views: [purchaseRequestListView, purchaseRequestFormView],
  links: [requestToDepartment, requestToItems],

  extensions: {
    permissionGroups: [
      {
        name: "purchase_user",
        label: "Purchase User",
        description: "Can create and view purchase requests",
        permissions: {
          "cap-purchase-demo": {
            purchase_request: {
              actions: {
                submit_purchase_request: true,
              },
              data: { read: "all", write: "all" },
            },
          },
        },
      },
      {
        name: "purchase_manager",
        label: "Purchase Manager",
        description: "Can approve purchase requests",
        permissions: {
          "cap-purchase-demo": {
            purchase_request: {
              actions: {
                submit_purchase_request: true,
                approve_purchase_request: true,
              },
              data: { read: "all", write: "all" },
            },
          },
        },
      },
    ],
  },

  seed: {
    purchase_request: purchaseRequestSeedData,
    department: departmentSeedData,
    purchase_item: purchaseItemSeedData,
  },
});
