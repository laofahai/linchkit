---
"@linchkit/cli": patch
---

Register capability-defined event handlers in the `linch dev` boot path.

`collect-capabilities` already gathered each capability's `eventHandlers`, but the dev wiring never registered them onto the `EventHandlerRegistry` — it only used the registry for the OutboxWorker and a health check. As a result, capability `defineEventHandler` reactions never fired under `linch dev`. The handlers are now threaded through `WireDevEnginesInput` and registered onto the registry right after the event bus is created (mirroring the `linch events` bootstrap path), with the existing skip-on-duplicate guard.
