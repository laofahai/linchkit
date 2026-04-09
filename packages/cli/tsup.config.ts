import { defineConfig } from "tsup";

export default defineConfig({
  tsconfig: "tsconfig.build.json",
  entry: {
    index: "src/index.ts",
  },
  format: ["esm"],
  dts: false,
  clean: true,
  target: "es2022",
  banner: {
    js: "#!/usr/bin/env bun",
  },
  esbuildOptions(options) {
    // Strip the source file's #!/usr/bin/env bun shebang so only the
    // banner's #!/usr/bin/env node remains in the output.
    options.define = {
      ...options.define,
    };
  },
  esbuildPlugins: [
    {
      name: "strip-source-shebang",
      setup(build) {
        build.onLoad({ filter: /packages\/cli\/src\/index\.ts$/ }, async (args) => {
          const fs = await import("node:fs");
          let contents = fs.readFileSync(args.path, "utf8");
          contents = contents.replace(/^#!.*\n/, "");
          return { contents, loader: "ts" };
        });
      },
    },
  ],
  external: [
    "@linchkit/core",
    "@linchkit/devtools",
    "@linchkit/cap-flow-restate",
    "@linchkit/cap-migration",
    "citty",
    "consola",
  ],
});
