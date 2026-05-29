# @linchkit/cap-adapter-a2a

A2A (Agent-to-Agent) protocol adapter for LinchKit (Spec 15 §6.5) — it will expose the Command Layer over the A2A protocol so external agents can discover and invoke LinchKit Actions. **Status: SKELETON.** This package currently registers only a no-op `a2a` transport (start/stop) and a minimal config schema; the real protocol logic — Agent Card publication, JSON-RPC handling, and the task/message-send lifecycle — is intentionally deferred to later slices pending an owner decision. Tracked by issue #89 (slice S1).
