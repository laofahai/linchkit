/**
 * Capability definition for cap-adapter-a2a
 *
 * Static, zero-config export of the A2A adapter capability. It mirrors the
 * parametrized `createCapAdapterA2a` factory with default options so the two
 * stay in sync. SKELETON slice — see factory.ts and issue #89.
 */

import type { CapabilityDefinition } from "@linchkit/core";
import { createCapAdapterA2a } from "./factory";

export const capAdapterA2a: CapabilityDefinition = createCapAdapterA2a();
