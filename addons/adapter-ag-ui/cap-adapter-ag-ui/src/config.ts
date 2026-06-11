/**
 * cap-adapter-ag-ui configuration schema
 *
 * Declares config keys for the AG-UI (Agent-User Interaction) transport adapter.
 * Only the minimal connection fields are defined for now; richer options
 * (auth, run-session limits, streaming knobs) arrive with later slices.
 */

import { defineConfigSchema } from "@linchkit/core/config";
import { z } from "zod";

export const capAdapterAgUiConfig = defineConfigSchema("cap-adapter-ag-ui", {
  enabled: z.boolean().default(false).describe("Enable the AG-UI transport"),
  basePath: z
    .string()
    .default("/api/agui")
    .describe("Base path the AG-UI run endpoint is mounted under"),
  port: z.coerce.number().default(3003).describe("Port for the standalone AG-UI HTTP server"),
});
