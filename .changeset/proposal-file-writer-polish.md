---
"@linchkit/core": patch
---

Polish ProposalFileWriter — slug-based filenames (date + title + short-id) and opt-in Biome formatter via `formatter` option. Backwards-compatible: default behaviour unchanged.

Generated TypeScript files now use a human-readable prefix of the form `_YYYYMMDD__<slugified-title>__<short-id>.<changeName>.<kindSuffix>.ts`. The date stamp comes from `proposal.createdAt` (UTC), the slug from `proposal.title` (lowercase a-z0-9, length-capped at 40, trailing dashes trimmed), and the short-id is the last 8 chars of `proposal.id` — matching the convention used by ProposalGitCommitter. Empty or special-char-only titles collapse to `_YYYYMMDD__<short-id>...`.

A new `formatter` option opts source through a TypeScript formatter before the file is written:

- `formatter: true` — pipe source through `bunx @biomejs/biome format --stdin-file-path=<path>` so generated files match the repo style and avoid churn on the developer's first save.
- `formatter: (source, filename) => Promise<string>` — custom async formatter.
- Omitted / `false` — no formatting (preserves prior behaviour, no breaking change).

Formatter failures are swallowed and logged via `logger?.warn?.(...)`; the un-formatted source is written in their place so a stylistic step can never block code generation.

Closes #368.
