/**
 * Project scaffolding templates: config, package.json, tsconfig, env, gitignore
 */

export function linchkitConfigTemplate(): string {
  return `import { defineConfig } from '@linchkit/core'

export default defineConfig({
  // Database (optional — omit for in-memory mode)
  database: {
    url: process.env.DATABASE_URL,
  },

  // Server
  server: {
    port: Number(process.env.PORT) || 3001,
    host: '0.0.0.0',
  },

  // Add capabilities here:
  // import { capAuth } from '@linchkit/cap-auth'
  // capabilities: [capAuth],
  capabilities: [],
})
`;
}

export function packageJsonTemplate(projectName: string): string {
  return JSON.stringify(
    {
      name: projectName,
      version: "0.1.0",
      type: "module",
      scripts: {
        dev: "linch dev",
        "dev:server": "linch dev --server",
        test: "bun test",
        "db:generate": "linch db generate",
        "db:migrate": "linch db migrate",
      },
      dependencies: {
        "@linchkit/core": "^0.1.0",
        "@linchkit/cli": "^0.1.0",
        "@linchkit/cap-adapter-server": "^0.1.0",
      },
    },
    null,
    2,
  );
}

export function tsconfigTemplate(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ES2022",
        moduleResolution: "bundler",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        types: ["bun-types"],
      },
      include: ["**/*.ts"],
      exclude: ["node_modules"],
    },
    null,
    2,
  );
}

export function envExampleTemplate(): string {
  return `# Database (omit for in-memory mode)
# DATABASE_URL=postgres://user:password@localhost:5432/mydb

# Server
PORT=3001
`;
}

export function gitignoreTemplate(): string {
  return `node_modules/
dist/
.env
.linchkit/
drizzle/
*.log
`;
}
