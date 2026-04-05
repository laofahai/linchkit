---
name: Phase 3 rename in progress
description: schema→entity and link→relation property rename is partially done. 121 typecheck errors remain in 22 files. Plan at docs/rename-phase3-plan.md.
type: project
---

Phase 3 of Schema→Entity, Link→Relation rename is in progress.

**What's done:** Core type definitions, MCP adapter tools+tests, spec docs, CLAUDE.md, RelationDescriptor/LinkInfo types.

**What remains:** 121 typecheck errors across 22 implementation files. 168 test failures (mostly cascading from type errors). Key properties: `.schema`→`.entity`, `targetSchema`→`targetEntity`, `relatedSchema`→`relatedEntity`, `linkName`→`relationName`, `getBySchema`→`getByEntity`.

**Why:** Plan is at `docs/rename-phase3-plan.md`. Two files were damaged by overly aggressive sed (`entity-list.tsx`, `markdown-renderer.ts`) — restore via `git checkout` first.

**How to apply:** Run `bun run typecheck` to get error list, fix file by file, verify with `bun test`.
