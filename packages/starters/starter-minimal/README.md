# @linchkit/starter-minimal

A minimal starter pack for LinchKit (Spec 14). Activating it pulls in the
baseline authentication and permission stack through the capability dependency
resolver — no need to list each capability by hand.

## Installation

```bash
bun add @linchkit/starter-minimal
```

## Peer Dependencies

- `@linchkit/core` ^0.2.0

## Usage

Add the starter to your `linchkit.config.ts`. The boot path resolves its
dependencies (`cap-auth`, `cap-permission`) from the discovered addons pool and
auto-installs any companion capabilities.

```ts
import { defineConfig } from "@linchkit/core";
import { starterMinimal } from "@linchkit/starter-minimal";

export default defineConfig({
  capabilities: [starterMinimal],
  addons_path: ["./addons"],
});
```

## Dependencies

This starter declares the following capability dependencies (by definition
name, not npm package name):

- `cap-auth` — authentication
- `cap-permission` — RBAC

## Links

- [Repository](https://github.com/laofahai/linchkit)
