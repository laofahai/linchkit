/**
 * Capability definition for cap-adapter-ag-ui (SKELETON).
 *
 * Registers the AG-UI transport (Spec 15 §6.5). The parametrized factory lives
 * in factory.ts; this static export simply invokes it with defaults so the two
 * never diverge (mirroring cap-adapter-a2a). Real AG-UI logic is deferred to
 * later slices (#89).
 */

import { createCapAdapterAgUi } from "./factory";

export const capAdapterAgUi = createCapAdapterAgUi();
