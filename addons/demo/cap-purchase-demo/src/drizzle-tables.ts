/**
 * Drizzle table definitions for cap-purchase-demo
 *
 * Optional explicit export of pgTable definitions for this capability.
 * When present, linch CLI can use these directly; otherwise it generates
 * tables automatically from EntityDefinition via generateDrizzleTable().
 */

import { generateDrizzleTable } from "@linchkit/core/server";
import { purchaseRequestSchema } from "./schemas/purchase-request";

export const purchaseRequestTable = generateDrizzleTable(purchaseRequestSchema);
