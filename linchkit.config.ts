import { capAuth } from "@linchkit/cap-auth";
import { capPermission } from "@linchkit/cap-permission";
import { capPurchaseDemo } from "@linchkit/cap-purchase-demo";
import { defineConfig } from "@linchkit/core";

export default defineConfig({
  server: {
    port: 3001,
    host: "0.0.0.0",
  },

  ai: {
    defaultProvider: "anthropic",
    providers: {
      anthropic: {
        apiKey: "$env.ANTHROPIC_API_KEY",
        defaultModel: "claude-sonnet-4-20250514",
        models: {
          fast: "claude-haiku-4-5-20251001",
          standard: "claude-sonnet-4-20250514",
          advanced: "claude-opus-4-20250514",
        },
      },
    },
  },

  capabilities: [capAuth, capPermission, capPurchaseDemo],
});
