import { defineConfig } from "tsup";

export default defineConfig({
  tsconfig: "tsconfig.build.json",
  entry: {
    index: "src/index.ts",
    "types-entry": "src/types-entry.ts",
    "define-entry": "src/define-entry.ts",
    "server-entry": "src/server-entry.ts",
    "config/index": "src/config/index.ts",
    "utils/env": "src/utils/env.ts",
    "ai/index": "src/ai/index.ts",
  },
  format: ["esm"],
  dts: false,
  clean: true,
  target: "es2022",
  external: [
    "croner",
    "drizzle-orm",
    "pino",
    "postgres",
    "zod",
    // Dev/workspace deps — never bundle
    "@linchkit/cap-migration",
    "@linchkit/devtools",
  ],
});
