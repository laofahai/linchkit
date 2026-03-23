import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./.linchkit/drizzle-schema.generated.ts",
  out: "./drizzle/migrations",
  // Required by db:migrate/db:push/db:pull; not needed for db:generate
  ...(process.env.DATABASE_URL ? { dbCredentials: { url: process.env.DATABASE_URL } } : {}),
});
