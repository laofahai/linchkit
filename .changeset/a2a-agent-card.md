---
"@linchkit/cap-adapter-a2a": minor
---

feat(a2a): A2A v1.0 AgentCard generator + a2a exposure flag (phase-1 spike, #89)

Maps the OntologyRegistry's exposed actions to an A2A v1.0 AgentCard at boot. Exposure follows the MCP pattern (`exposure.a2a === false` / `exposure.internal === true` exclude; `exposure === "all"` includes; unknown values fail closed).
