import { capAdapterServer } from "@linchkit/cap-adapter-server";
import { capAdapterUiReact } from "@linchkit/cap-adapter-ui-react";
import { createCapAuth, createDevAuthProvider } from "@linchkit/cap-auth";
import { createCapPermission } from "@linchkit/cap-permission";
import { capPurchaseDemo } from "@linchkit/cap-purchase-demo";
import { defineConfig, PermissionRegistry } from "@linchkit/core";

const permissionRegistry = new PermissionRegistry();
permissionRegistry.register({
  name: "system_admin",
  label: "Administrator",
  description: "Full access (bypasses permission checks via system_admin shortcut)",
  permissions: {},
});
permissionRegistry.register({
  name: "user",
  label: "Standard User",
  description: "Read access and limited write operations",
  permissions: {
    cap_purchase_demo: {
      purchase_request: {
        actions: {
          create_purchase_request: true,
          list_purchase_request: true,
        },
        data: {
          read: "all",
          write: {
            condition: {
              field: "created_by",
              operator: "eq",
              value: "$actor.id",
            },
          },
        },
      },
    },
  },
});

export default defineConfig({
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

  capabilities: [
    capAdapterServer,
    capAdapterUiReact,
    createCapAuth({ provider: createDevAuthProvider() }),
    createCapPermission({
      registry: permissionRegistry,
      publicActions: ["login", "logout", "health"],
    }),
    capPurchaseDemo,
  ],
});
