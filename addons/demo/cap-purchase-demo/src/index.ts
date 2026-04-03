/**
 * @linchkit/cap-purchase-demo — Purchase request demo capability
 *
 * Provides a complete purchase request workflow with schema,
 * custom actions (submit/approve), state machine, links, views,
 * interfaces, derived fields, automations, and data masking.
 */

export { approveAction } from "./actions/approve";
export { rejectAction } from "./actions/reject";
export { submitAction } from "./actions/submit";
export {
  autoSetApprovedFields,
  autoSetSubmittedAt,
  notifyHighPrioritySubmission,
} from "./automations/purchase-status";
export { capPurchaseDemo } from "./capability";
export { purchaseApprovalFlow } from "./flows/purchase-approval";
export { auditableInterface } from "./interfaces/auditable";
export { requestToDepartment, requestToItems } from "./relations";
export { departmentSchema } from "./schemas/department";
export { purchaseItemSchema } from "./schemas/purchase-item";
export { purchaseRequestSchema } from "./schemas/purchase-request";
export { departmentSeedData, purchaseItemSeedData, purchaseRequestSeedData } from "./seed";
export { purchaseRequestState } from "./states/purchase-request";
export { purchaseRequestFormView } from "./views/form";
export { purchaseRequestListView } from "./views/list";
