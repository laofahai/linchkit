/**
 * @linchkit/cap-purchase-demo — Purchase request demo capability
 *
 * Provides a complete purchase request workflow with schema,
 * custom actions (submit/approve), state machine, links, and views.
 */

export { approveAction } from "./actions/approve";
export { submitAction } from "./actions/submit";
export { capPurchaseDemo } from "./capability";
export { requestToDepartment, requestToItems } from "./links";
export { departmentSchema } from "./schemas/department";
export { purchaseItemSchema } from "./schemas/purchase-item";
export { purchaseRequestSchema } from "./schemas/purchase-request";
export { departmentSeedData, purchaseItemSeedData, purchaseRequestSeedData } from "./seed";
export { purchaseRequestState } from "./states/purchase-request";
export { purchaseRequestFormView } from "./views/form";
export { purchaseRequestListView } from "./views/list";
