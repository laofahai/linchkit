# @linchkit/cap-auth

Authentication capability for LinchKit — provides the auth contract layer including schemas, actions (login, register, logout, refresh, API keys), middleware, and the `AuthProvider` interface. Concrete implementations are supplied by provider packages like `@linchkit/cap-auth-better-auth`.

## Installation

```bash
bun add @linchkit/cap-auth
```

## Peer Dependencies

- `@linchkit/core` ^0.1.0

## Usage

```ts
import { createCapAuth } from "@linchkit/cap-auth";
import { createBetterAuthProvider } from "@linchkit/cap-auth-better-auth";

const capAuth = createCapAuth({
  provider: createBetterAuthProvider({ database: db }),
});
```

### Auth Middleware

```ts
import { createAuthMiddleware } from "@linchkit/cap-auth";

const middleware = createAuthMiddleware({
  // options
});
```

### Schemas

```ts
import { userSchema, sessionSchema, tokenSchema, apiKeySchema } from "@linchkit/cap-auth";
```

## Links

- [Repository](https://github.com/laofahai/linchkit)
