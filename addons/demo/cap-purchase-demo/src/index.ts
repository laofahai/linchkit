/**
 * @linchkit/cap-purchase-demo — Purchase request demo capability
 *
 * Provides a complete purchase request workflow with schema,
 * custom actions (submit/approve), state machine, links, views,
 * interfaces, derived fields, event handlers, and data masking.
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
export { departmentEntity } from "./entities/department";
export { purchaseItemEntity } from "./entities/purchase-item";
export { purchaseRequestEntity } from "./entities/purchase-request";
export { purchaseApprovalFlow } from "./flows/purchase-approval";
export { auditableInterface } from "./interfaces/auditable";
export { requestToDepartment, requestToItems } from "./relations";
export { departmentSeedData, purchaseItemSeedData, purchaseRequestSeedData } from "./seed";
export { purchaseRequestState } from "./states/purchase-request";
export { purchaseRequestFormView } from "./views/form";
export { purchaseRequestListView } from "./views/list";
