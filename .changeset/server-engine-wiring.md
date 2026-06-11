---
"@linchkit/cap-adapter-server": minor
---

Activate dormant server-engine wiring so SSE subscriptions, approvals, and cache stats work.

The `createServer(...)` calls in both boot paths omitted engines that the rest of the stack expects:

- `http-transport.ts` (the real `linch dev` path) never passed `eventBus`, `approvalEngine`, or `cacheManager` from the transport context, so `/api/subscribe` (SSE), `/api/approvals`, and `/internal/cache/stats` were silently disabled (`subscription-api` bailed on a missing bus, `approval-api` returned 501).
- The in-process path (`assembleDevSchema` → `createRuntimeContext` → `createDevApp`) never built or wired an event bus at all, so domain events never reached SSE subscribers.

`assembleDevSchema` now builds an in-memory event bus and threads it through `createRuntimeContext` (which forwards it to the action executor so actions emit domain events) and into `createServer`. A new DB-free SSE e2e (`app.handle`) guards the path. Also adds a duplicate-name guard to action registration in `createRuntimeContext`, mirroring the existing `build-registries` / `http-transport` guard.
