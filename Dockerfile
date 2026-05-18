# syntax=docker/dockerfile:1.7
#
# LinchKit production image — Spec 12 deployment foundation.
#
# Strategy:
#   Stage 1 (builder): full Bun image; installs every workspace dependency,
#     copies sources, and produces `dist/` outputs for the npm-published
#     packages (`@linchkit/core`, `@linchkit/cli`, `@linchkit/devtools`)
#     plus the addon source (Bun executes addon TypeScript directly).
#   Stage 2 (runtime): slim Bun image; copies only production dependencies
#     and built artefacts, drops privileges to a non-root user, and exposes
#     the HTTP port.
#
# Runtime: Bun only. Never node / npm / npx — see /CLAUDE.md (project
# instructions) and /AGENTS.md.

# ── Stage 1: Build ─────────────────────────────────────────
FROM oven/bun:1.2.15 AS builder

WORKDIR /app

# Workspace manifests first so dependency installation is cacheable across
# source-only changes.
COPY package.json bun.lock .bunfig.toml tsconfig.json ./

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

RUN bun install --frozen-lockfile

# Copy source last so source-only edits don't bust the dependency layer.
COPY packages/ packages/
COPY addons/ addons/
COPY config/ config/

# Build npm-published packages (tsup emits dist/).
RUN bun run build

# ── Stage 2: Runtime ───────────────────────────────────────
FROM oven/bun:1.2.15-slim AS production

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

# `curl` is required by the HEALTHCHECK directive below. `ca-certificates`
# keeps outbound TLS (to Postgres, OTLP collectors, etc.) trustable.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Workspace manifests for production install (no devDependencies).
COPY package.json bun.lock .bunfig.toml tsconfig.json ./

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

RUN bun install --frozen-lockfile --production

# Built outputs for npm-published packages.
COPY --from=builder /app/packages/core/dist/ packages/core/dist/
COPY --from=builder /app/packages/cli/dist/ packages/cli/dist/
COPY --from=builder /app/packages/devtools/dist/ packages/devtools/dist/

# Source kept so Bun can resolve the "bun" export condition (src/*.ts).
COPY --from=builder /app/packages/core/src/ packages/core/src/
COPY --from=builder /app/packages/cli/src/ packages/cli/src/
COPY --from=builder /app/packages/devtools/src/ packages/devtools/src/

# Addons are not compiled — Bun runs the TypeScript directly.
COPY --from=builder /app/addons/ addons/

COPY --from=builder /app/config/ config/

RUN addgroup --system --gid 1001 bunjs \
  && adduser --system --uid 1001 --ingroup bunjs bunuser \
  && chown -R bunuser:bunjs /app
USER bunuser

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:3001/health || exit 1

CMD ["bun", "addons/adapter-server/cap-adapter-server/src/dev.ts"]
