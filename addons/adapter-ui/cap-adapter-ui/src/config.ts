/**
 * cap-adapter-ui configuration schema
 *
 * Declares config keys for the React UI dev server transport.
 */

import { defineConfigSchema } from "@linchkit/core/config";
import { z } from "zod";

export const capAdapterUiConfig = defineConfigSchema("cap-adapter-ui", {
  port: z.coerce.number().default(3000),
});
