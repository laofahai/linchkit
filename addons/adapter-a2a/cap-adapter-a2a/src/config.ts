/**
 * cap-adapter-a2a configuration schema
 *
 * Declares config keys for the A2A (Agent-to-Agent) protocol transport adapter.
 * Minimal for the SKELETON slice — real protocol options arrive in later slices.
 * See Spec 15 §6.5 and issue #89.
 */

import { defineConfigSchema } from "@linchkit/core/config";
import { z } from "zod";

export const capAdapterA2aConfig = defineConfigSchema("cap-adapter-a2a", {
  enabled: z.boolean().default(false).describe("Enable the A2A transport adapter"),
  port: z.coerce.number().default(3003).describe("Port for the A2A HTTP server"),
  basePath: z.string().default("/a2a").describe("Base path the A2A endpoints are mounted under"),
});
