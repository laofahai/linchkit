import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));

// API server the dev UI proxies to. Defaults to the standard :3001 dev server;
// `LINCHKIT_UI_PROXY_TARGET` retargets it so a self-contained e2e (Spec 71 P5 §8)
// can run the API on an isolated port without clobbering a hand-run dev server.
const PROXY_TARGET = process.env.LINCHKIT_UI_PROXY_TARGET ?? "http://localhost:3001";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 3000,
    proxy: {
      "/graphql": PROXY_TARGET,
      "/api": PROXY_TARGET,
      "/health": PROXY_TARGET,
    },
  },
});
