# @linchkit/cap-adapter-ag-ui

AG-UI (Agent-User Interaction) protocol adapter for LinchKit (Spec 15 §6.5). AG-UI is the
CopilotKit team's open standard for bidirectional, real-time communication between an AI agent
and a frontend UI over SSE — enabling AI-assisted form filling, Human-in-the-Loop approval
(AI submits a Proposal → UI renders it → user confirms), and live streaming of agent progress.
**Status: Phase 1** ([#89](https://github.com/laofahai/linchkit/issues/89)) — uses the canonical
[`@ag-ui/core`](https://www.npmjs.com/package/@ag-ui/core) protocol package (re-exported through
`src/protocol.ts`, the addon's single protocol import point) and a `POST /api/agui/run` endpoint
that validates a `RunAgentInput` body against the official `RunAgentInputSchema` (`messages`,
`tools` and `context` are required arrays per the upstream contract) and streams protocol
events over SSE (`RUN_STARTED → TEXT_MESSAGE_* / TOOL_CALL_* → RUN_FINISHED`, `RUN_ERROR` on
failure) by bridging the existing assistant `AIService` seam. Tool calls are emitted for the
frontend to execute; shared-state sync (`STATE_SNAPSHOT`/`STATE_DELTA`) and Human-in-the-Loop
Proposal prompts arrive in later slices. The transport is opt-in (`autoInstall: false`,
`enabled: false` by default) and runs as a standalone server on port 3003, mirroring
cap-adapter-mcp's SSE transport.

## Peer Dependencies

- `@linchkit/core` ^0.2.0

## Links

- [Repository](https://github.com/laofahai/linchkit)
