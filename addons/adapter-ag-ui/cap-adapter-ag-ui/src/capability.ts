/**
 * Capability definition for cap-adapter-ag-ui.
 *
 * Registers the AG-UI transport (Spec 15 §6.5, issue #89). The parametrized
 * factory lives in factory.ts; this static export simply invokes it with
 * defaults so the two never diverge (mirroring cap-adapter-a2a).
 */

import { createCapAdapterAgUi } from "./factory";

export const capAdapterAgUi = createCapAdapterAgUi();
