/**
 * cap-adapter-ui-react configuration schema
 *
 * Declares config keys for the React UI dev server transport.
 */

import { defineConfigSchema } from "@linchkit/core/config";
import { z } from "zod";

export const capAdapterUiReactConfig = defineConfigSchema("cap-adapter-ui-react", {
  port: z.coerce.number().default(3000),
});
