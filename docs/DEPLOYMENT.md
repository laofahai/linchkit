# LinchKit Deployment Guide

Operator guide for the production-readiness foundation described in
[Spec 12 — Deployment strategy](specs/12_deployment.md). Tracks GitHub issue
`#72`. Covers building the image, running it with Docker Compose, the
environment contract, health endpoints, and rolling-restart guidance.

## 1. Build the image

The image is multi-stage: Bun builds the workspace, then artefacts ship in
a slim Bun runtime. Bun is the only runtime — `node`, `npm`, `npx` are not
installed in the runtime stage.

```bash
docker build -t linchkit-server:latest .
```

The build uses `bun install --frozen-lockfile`, runs `bun run build` for
the npm-published packages, then copies addon source verbatim (addons are
executed directly by Bun).

## 2. Run with Compose

The production compose file (`docker-compose.deploy.yml`) brings up the
server and a `pgvector/pgvector:pg16` Postgres. It deliberately does NOT
include dev-only services (test database, Restate dev image, etc.).

```bash
cp .env.production.example .env.production
# edit .env.production with real secrets
docker compose --env-file .env.production -f docker-compose.deploy.yml up -d
```

Bring it down with:

```bash
docker compose -f docker-compose.deploy.yml down
```

## 3. Environment contract

`validateEnv()` (exported from `@linchkit/core`) audits the env at startup.
Missing required variables abort the boot; soft issues become warnings.

| Variable                     | Required | Purpose                                                                 |
| ---------------------------- | -------- | ----------------------------------------------------------------------- |
| `DATABASE_URL`               | Yes      | Postgres connection string consumed by `DrizzleDataProvider`.           |
| `JWT_SECRET`                 | Yes      | Signs / verifies auth tokens. Recommend >= 32 random bytes.             |
| `NODE_ENV`                   | No       | `production`, `staging`, `development`, or `test`. Unknown -> warning.  |
| `OTEL_EXPORTER_OTLP_ENDPOINT`| No       | When unset in production, traces are dropped (warning at boot).         |
| `REDIS_URL`                  | No       | When unset in production, cache stays in-memory (warning at boot).      |
| `SERVER_PORT`                | No       | Host port the compose file publishes. Default `3001`.                   |
| `POSTGRES_USER` / `_PASSWORD` / `_DB` | Yes (compose) | Bootstraps the `postgres` service. Must match `DATABASE_URL`. |

## 4. Health and readiness

Two infrastructure-level probes are mounted by the server (`addons/adapter-server/cap-adapter-server/src/routes/health.ts`):

- `GET /health` — process liveness. Always returns 200 with
  `{ status: "ok", uptime, version }`. Used by container orchestrators to
  decide whether to restart the process. Free of external dependencies.
- `GET /ready` — readiness. Returns 200 with per-dependency check results
  when every dependency is reachable; otherwise 503. The current readiness
  signal is the data provider (`DrizzleDataProvider.ping()`).

Both endpoints bypass the CommandLayer auth slot so they remain reachable
even if the auth capability is unhealthy.

The Dockerfile's `HEALTHCHECK` curls `/health` every 30 seconds. Compose
also runs the same check against the `server` service.

## 5. Rolling restart

The single-host blue-green pattern from Spec 12 §4 maps onto Compose as a
two-step recreate:

```bash
# 1. Build the new image (does not stop the running container).
docker build -t linchkit-server:latest .

# 2. Recreate just the server service with the new image. Compose waits
#    for postgres to stay healthy and brings the new container up before
#    tearing the old one down (rolling update on a single host).
docker compose --env-file .env.production -f docker-compose.deploy.yml up -d --no-deps server
```

Operational tips:

- Always run `bun run check` and `bun run typecheck` against the source
  before rebuilding the image. The image build does not re-run these.
- For schema-changing releases, run the migration before recreating the
  server (Spec 12 §5.2: add columns first, then deploy code; deploy code
  first, then drop columns).
- Roll back by retagging the previous image and re-running the recreate
  step.

## 6. Out of scope (foundation slice)

This document covers the M0 / M1 foundation only. The following live in
later milestones and Spec 12:

- Nginx upstream switching for true blue-green (Spec 12 §4).
- GitHub webhook -> server-side pull / build / deploy (Spec 12 §2).
- Multi-host rolling updates with a Control plane (Spec 12 §7).
- AI Proposal -> automatic PR -> automatic deploy (Spec 12 §2 path B).
