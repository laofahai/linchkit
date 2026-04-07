# @linchkit/cap-permission

Permission management capability for LinchKit — RBAC-based permission groups, user-to-group assignments, and Command Layer permission slot middleware.

## Installation

```bash
bun add @linchkit/cap-permission
```

## Peer Dependencies

- `@linchkit/core` ^0.1.0

## Usage

### Register the Capability

```ts
import { createCapPermission } from "@linchkit/cap-permission";

const permission = createCapPermission({
  // options
});
```

### Permission Middleware

```ts
import { createPermissionMiddleware } from "@linchkit/cap-permission";

const middleware = createPermissionMiddleware({
  // options
});
```

### Schemas

```ts
import { permissionGroupSchema, permissionAssignmentSchema } from "@linchkit/cap-permission";
```

### Actions

Built-in actions: `createGroupAction`, `assignUserAction`, `revokeUserAction`, `updatePermissionsAction`.

## Links

- [Repository](https://github.com/laofahai/linchkit)
