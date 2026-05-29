/**
 * @linchkit/cap-adapter-a2a — A2A (Agent-to-Agent) protocol adapter
 *
 * Exposes the LinchKit Command Layer over the A2A protocol (Spec 15 §6.5).
 * SKELETON slice (#89): a no-op transport plus config schema; protocol logic
 * is deferred to later slices.
 */

// Transport definition
export { a2aTransport } from "./a2a-transport";
// Static capability export
export { capAdapterA2a } from "./capability";
// Config schema
export { capAdapterA2aConfig } from "./config";
// Factory
export type { CapAdapterA2aOptions } from "./factory";
export { createCapAdapterA2a } from "./factory";

import { capAdapterA2a } from "./capability";

export default capAdapterA2a;
