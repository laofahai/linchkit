---
"@linchkit/core": minor
"@linchkit/cap-adapter-mcp": minor
"@linchkit/cap-adapter-server": minor
---

feat(adapter-mcp): `resolve_schema_intent` MCP tool — NL→governed proposal (#583)

MCP agents can now send a natural-language utterance and get a governed proposal draft, the same capability the HTTP route provides — closing the "every channel" gap for 说→有. Adds `proposalEngine` to `TransportContext` and forwards it through the MCP factory, which also activates `create_proposal` (previously dormant in the dev MCP path because the engine never reached the adapter).
