/**
 * linch dev — Start the development server (placeholder)
 */

import { defineCommand } from "citty";

export const devCommand = defineCommand({
  meta: {
    name: "dev",
    description: "Start the LinchKit development server",
  },
  args: {
    port: {
      type: "string",
      description: "Server port",
      default: "3000",
    },
    host: {
      type: "string",
      description: "Server host",
      default: "0.0.0.0",
    },
  },
  run({ args }) {
    const port = args.port;
    const host = args.host;

    console.log("Starting LinchKit dev server...");
    console.log(`Server ready at http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
  },
});
