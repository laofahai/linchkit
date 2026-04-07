# @linchkit/cap-auth-better-auth

Better Auth provider for LinchKit authentication — concrete `AuthProvider` implementation using [better-auth](https://www.better-auth.com/) as the authentication engine. Recommended for production use.

## Installation

```bash
bun add @linchkit/cap-auth-better-auth
```

## Peer Dependencies

- `@linchkit/core` ^0.1.0
- `@linchkit/cap-auth` ^0.1.0
- `drizzle-orm` >=0.41.0

## Usage

```ts
import { createCapAuth } from "@linchkit/cap-auth";
import { createBetterAuthProvider } from "@linchkit/cap-auth-better-auth";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const db = drizzle(postgres(process.env.DATABASE_URL!));

const capAuth = createCapAuth({
  provider: createBetterAuthProvider({ database: db }),
});
```

### Seed System Admin

```ts
import { seedSystemAdmin } from "@linchkit/cap-auth-better-auth";

await seedSystemAdmin({
  email: "admin@example.com",
  password: "secure-password",
});
```

## Links

- [Repository](https://github.com/laofahai/linchkit)
