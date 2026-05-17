/**
 * cap-observability-otel capability descriptor.
 *
 * Phase 1 ships the adapter + bootstrap helpers only; the capability
 * descriptor itself is a shape-only registration so the host can list
 * it alongside other capabilities. Registration does NOT auto-start
 * the OTel SDK or auto-swap the observability bundle — both are
 * runtime + network side-effects that callers must opt in to
 * explicitly.
 *
 * Opt-in path:
 * ```ts
 * import { setObservability } from "@linchkit/core/server";
 * import {
 *   bootstrapNodeSdk,
 *   createOtelAdapter,
 * } from "@linchkit/cap-observability-otel";
 *
 * const sdk = bootstrapNodeSdk({ serviceName: "linchkit-server" });
 * sdk.start();
 * setObservability(createOtelAdapter({ serviceName: "linchkit-server" }));
 * ```
 */

import { defineCapability } from "@linchkit/core";

export const capObservabilityOtel = defineCapability({
  name: "cap-observability-otel",
  label: "OpenTelemetry Observability",
  description:
    "OpenTelemetry adapter for the LinchKit observability seam. " +
    "Provides createOtelAdapter() + bootstrapNodeSdk() helpers; the " +
    "host opts in by calling setObservability(createOtelAdapter(...)) " +
    "after bootstrapping the NodeSDK.",
  type: "standard",
  category: "system",
  version: "0.1.0",
  group: "observability",
  // Explicit opt-in only — OTel has runtime + network cost so the host
  // must call setObservability(...) themselves.
  autoInstall: false,
});
