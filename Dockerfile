# ── Stage 1: Install dependencies and build ─────────────────
FROM oven/bun:latest AS builder

WORKDIR /app

# Copy workspace config files first for better layer caching
COPY package.json bun.lock .bunfig.toml tsconfig.json ./

# Copy all package.json files to resolve workspace dependencies
COPY packages/core/package.json packages/core/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/devtools/package.json packages/devtools/package.json
COPY addons/adapter-server/cap-adapter-server/package.json addons/adapter-server/cap-adapter-server/package.json
COPY addons/adapter-mcp/cap-adapter-mcp/package.json addons/adapter-mcp/cap-adapter-mcp/package.json
COPY addons/auth/cap-auth/package.json addons/auth/cap-auth/package.json
COPY addons/auth/cap-auth-better-auth/package.json addons/auth/cap-auth-better-auth/package.json
COPY addons/permission/cap-permission/package.json addons/permission/cap-permission/package.json
COPY addons/ai-provider/cap-ai-provider/package.json addons/ai-provider/cap-ai-provider/package.json
COPY addons/chatter/cap-chatter/package.json addons/chatter/cap-chatter/package.json
COPY addons/flow-restate/cap-flow-restate/package.json addons/flow-restate/cap-flow-restate/package.json
COPY addons/migration/cap-migration/package.json addons/migration/cap-migration/package.json
COPY addons/demo/cap-purchase-demo/package.json addons/demo/cap-purchase-demo/package.json
COPY addons/adapter-ui/cap-adapter-ui/package.json addons/adapter-ui/cap-adapter-ui/package.json
COPY addons/adapter-ui/cap-adapter-ui/ui-kit/package.json addons/adapter-ui/cap-adapter-ui/ui-kit/package.json

# Install all dependencies (including devDependencies for build)
RUN bun install --frozen-lockfile

# Copy source code
COPY packages/ packages/
COPY addons/ addons/
COPY config/ config/

# Build packages (core, cli, devtools produce dist/ via tsup)
RUN bun run build

# ── Stage 2: Production image ───────────────────────────────
FROM oven/bun:latest AS production

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

# Copy workspace config
COPY package.json bun.lock .bunfig.toml tsconfig.json ./

# Copy all package.json files (needed for workspace resolution)
COPY --from=builder /app/packages/core/package.json packages/core/package.json
COPY --from=builder /app/packages/cli/package.json packages/cli/package.json
COPY --from=builder /app/packages/devtools/package.json packages/devtools/package.json
COPY --from=builder /app/addons/adapter-server/cap-adapter-server/package.json addons/adapter-server/cap-adapter-server/package.json
COPY --from=builder /app/addons/adapter-mcp/cap-adapter-mcp/package.json addons/adapter-mcp/cap-adapter-mcp/package.json
COPY --from=builder /app/addons/auth/cap-auth/package.json addons/auth/cap-auth/package.json
COPY --from=builder /app/addons/auth/cap-auth-better-auth/package.json addons/auth/cap-auth-better-auth/package.json
COPY --from=builder /app/addons/permission/cap-permission/package.json addons/permission/cap-permission/package.json
COPY --from=builder /app/addons/ai-provider/cap-ai-provider/package.json addons/ai-provider/cap-ai-provider/package.json
COPY --from=builder /app/addons/chatter/cap-chatter/package.json addons/chatter/cap-chatter/package.json
COPY --from=builder /app/addons/flow-restate/cap-flow-restate/package.json addons/flow-restate/cap-flow-restate/package.json
COPY --from=builder /app/addons/migration/cap-migration/package.json addons/migration/cap-migration/package.json
COPY --from=builder /app/addons/demo/cap-purchase-demo/package.json addons/demo/cap-purchase-demo/package.json
COPY --from=builder /app/addons/adapter-ui/cap-adapter-ui/package.json addons/adapter-ui/cap-adapter-ui/package.json
COPY --from=builder /app/addons/adapter-ui/cap-adapter-ui/ui-kit/package.json addons/adapter-ui/cap-adapter-ui/ui-kit/package.json

# Install production dependencies only
RUN bun install --frozen-lockfile --production

# Copy built packages (dist/ from tsup build)
COPY --from=builder /app/packages/core/dist/ packages/core/dist/
COPY --from=builder /app/packages/cli/dist/ packages/cli/dist/
COPY --from=builder /app/packages/devtools/dist/ packages/devtools/dist/

# Copy package source (Bun resolves "bun" export condition → src/*.ts)
COPY --from=builder /app/packages/core/src/ packages/core/src/
COPY --from=builder /app/packages/cli/src/ packages/cli/src/
COPY --from=builder /app/packages/devtools/src/ packages/devtools/src/

# Copy addon source (addons are not compiled, Bun runs TS directly)
COPY --from=builder /app/addons/ addons/

# Copy config directory (linchkit.config.ts)
COPY --from=builder /app/config/ config/

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:3001/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["bun", "run", "dev:server"]
