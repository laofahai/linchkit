/**
 * cap-adapter-ag-ui configuration schema
 *
 * Declares config keys for the AG-UI (Agent-User Interaction) transport adapter.
 * SKELETON — only the minimal connection fields are defined for now; richer
 * options (auth, run-session limits, streaming knobs) arrive with later slices.
 */

import { defineConfigSchema } from "@linchkit/core/config";
import { z } from "zod";

export const capAdapterAgUiConfig = defineConfigSchema("cap-adapter-ag-ui", {
  enabled: z.boolean().default(false).describe("Enable the AG-UI transport"),
  basePath: z
    .string()
    .default("/ag-ui")
    .describe("Base path for the AG-UI SSE endpoint mounted on the main HTTP server"),
  port: z.coerce
    .number()
    .default(3003)
    .describe("Port for a standalone AG-UI HTTP server (only used when not mounted)"),
});
