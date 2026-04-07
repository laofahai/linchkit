---
name: "linch:quality-gates"
description: "Four mandatory quality checks before committing"
---

# Quality Gates

All four checks MUST pass before committing code:

## 1. Capability Validation
```bash
linch validate
```
Validates all `defineXxx()` definitions against the meta-model schema.

## 2. Lint & Format
```bash
bun run check
```
Runs Biome for linting and formatting. Fix issues with `bun run check --fix`.

## 3. Type Check
```bash
bun run typecheck
```
Runs `tsc --noEmit` in strict mode. No `any` types allowed.

## 4. Tests
```bash
bun test
```
All tests must pass. Write tests alongside implementation.

## 5. File Size Check
Single files MUST NOT exceed 500 lines. If a file is too large:
- Split by responsibility (e.g. `discovery-tools.ts`, `validation-tools.ts`)
- Extract shared helpers to a separate file
- Each file should have one clear responsibility

## Dependency API Verification
When using third-party library APIs, MUST verify current usage via context7 MCP tools:
1. `resolve-library-id` — find the library's context7 ID
2. `query-docs` — query the specific API pattern
Do NOT rely on training data — libraries change frequently.

## Commit Convention
Use Conventional Commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`
