/**
 * cap-purchase-demo capability definition
 *
 * Demo purchase request capability showcasing:
 * - Schema interfaces (auditable)
 * - Derived/computed properties
 * - Event handlers (state change listeners)
 * - Data masking (sensitive fields)
 * - Rich schema presentation metadata
 * - Links, state machine, permission groups
 */

import { defineCapability } from "@linchkit/core";
import { approveAction } from "./actions/approve";
import { flagForReviewAction } from "./actions/flag-for-review";
import { rejectAction } from "./actions/reject";
import { submitAction } from "./actions/submit";
import {
  autoSetApprovedFields,
  autoSetSubmittedAt,
  notifyHighPrioritySubmission,
} from "./automations/purchase-status";
import { departmentEntity } from "./entities/department";
import { purchaseItemEntity } from "./entities/purchase-item";
import { purchaseRequestEntity } from "./entities/purchase-request";
import { purchaseApprovalFlow } from "./flows/purchase-approval";
import i18nEn from "./i18n/en.json";
import i18nZhCN from "./i18n/zh-CN.json";
import { auditableInterface } from "./interfaces/auditable";
import { requestToDepartment, requestToItems } from "./relations";
import { managerApprovalThresholdRule } from "./rules/manager-approval-threshold";
import { departmentSeedData, purchaseItemSeedData, purchaseRequestSeedData } from "./seed";
import { purchaseRejectionPattern } from "./sensors/purchase-rejection-pattern";
import { purchaseRequestState } from "./states/purchase-request";
import { departmentListView } from "./views/department-list";
import { purchaseRequestFormView } from "./views/form";
import { purchaseRequestListView } from "./views/list";

export const capPurchaseDemo = defineCapability({
  name: "cap-purchase-demo",
  label: "Purchase Request Demo",
  description:
    "Demo purchase request capability with approval workflow, " +
    "showcasing interfaces, derived fields, event handlers, and data masking",
  type: "standard",
  category: "business",
  version: "0.1.0",

  interfaces: [auditableInterface],
  entities: [purchaseRequestEntity, departmentEntity, purchaseItemEntity],
  actions: [submitAction, approveAction, rejectAction, flagForReviewAction],
  rules: [managerApprovalThresholdRule],
  states: [purchaseRequestState],
  views: [purchaseRequestListView, purchaseRequestFormView, departmentListView],
  relations: [requestToDepartment, requestToItems],
  flows: [purchaseApprovalFlow],
  eventHandlers: [autoSetSubmittedAt, autoSetApprovedFields, notifyHighPrioritySubmission],

  extensions: {
    i18n: {
      en: i18nEn,
      "zh-CN": i18nZhCN,
    },
    sensors: [purchaseRejectionPattern],
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
        description: "Can approve purchase requests and view sensitive fields",
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
