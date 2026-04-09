import { defineConfig } from "tsup";

export default defineConfig({
  tsconfig: "tsconfig.build.json",
  entry: {
    index: "src/index.ts",
    "documentation/index": "src/documentation/index.ts",
    "methodology/index": "src/methodology/index.ts",
    "governance/index": "src/governance/index.ts",
  },
  format: ["esm"],
  dts: false,
  clean: true,
  target: "es2022",
  external: ["@linchkit/core"],
});
