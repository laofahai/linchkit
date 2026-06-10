---
"@linchkit/core": patch
---

fix: keep the browser-safe client barrel free of Node built-ins — `release-compatibility.ts` (re-exported by `exports/client/migration.ts`) no longer imports `node:fs/promises` / `node:path` at module top level. The two filesystem entry points (`checkReleaseCompatibility`, `analyzeFile`) load them lazily, and `crossPlatformBasename` is a pure string implementation. Importing `@linchkit/core` in the browser previously threw "Module fs/promises has been externalized" and blanked the UI.
