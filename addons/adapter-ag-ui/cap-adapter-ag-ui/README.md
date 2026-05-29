# @linchkit/cap-adapter-ag-ui

AG-UI (Agent-User Interaction) protocol adapter for LinchKit (Spec 15 §6.5). AG-UI is the
CopilotKit team's open standard for bidirectional, real-time communication between an AI agent
and a frontend UI over SSE — enabling AI-assisted form filling, Human-in-the-Loop approval
(AI submits a Proposal → UI renders it → user confirms), and live streaming of agent progress.
**Status: SKELETON** — this package currently ships only the capability/transport scaffold; the
real AG-UI logic (SSE event encoder, run-session, and `aiService.completeStream` wiring) is
deferred to later slices pending an owner decision. The transport is a no-op `start`/`stop`. See
issue [#89](https://github.com/laofahai/linchkit/issues/89).

## Peer Dependencies

- `@linchkit/core` ^0.1.0

## Links

- [Repository](https://github.com/laofahai/linchkit)
