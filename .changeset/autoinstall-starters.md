---
"@linchkit/core": patch
"@linchkit/starter-minimal": patch
---

feat(core): wire the capability resolver into the boot path + ship `starter-minimal` (Spec 14, #121, first slice)

New `@linchkit/core/server` exports `mergeCapabilityPool(explicit, discovered)` (dedup by `name`, explicit wins) and `resolveCapabilities(explicit, discovered)` (runs `resolveDependencies` then `resolveAutoInstall` over the merged pool). The CLI gains `resolveActiveCapabilities(config)` in `load-config.ts`, and `linch dev` now activates the resolved set (config capabilities + `addons_path` discovery → pulled deps → auto-installed companions) instead of only the explicitly-listed ones. The other CLI commands are migrated in a fast-follow.

New package `@linchkit/starter-minimal`: a baseline starter capability (`name: "starter-minimal"`) declaring `dependencies: ["cap-auth", "cap-permission"]`, so adding it to a project's config pulls in the auth + permission stack through the resolver.
