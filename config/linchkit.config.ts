import { defineConfig } from "@linchkit/core";
import { capabilities } from "./capabilities";

export default defineConfig({
  addons_path: ["./addons"],

  server: {
    port: 3001,
    host: "0.0.0.0",
  },

  database: {
    url: "$env.DATABASE_URL",
  },

  ai: {
    defaultProvider: "volcengine",
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
      volcengine: {
        type: "openai",
        apiKey: "$env.VOLCENGINE_API_KEY",
        endpoint: "https://ark.cn-beijing.volces.com/api/coding/v3",
        defaultModel: "ark-code-latest",
        models: {
          fast: "ark-code-latest",
          standard: "ark-code-latest",
          advanced: "ark-code-latest",
        },
      },
    },
  },

  capabilities,
});
