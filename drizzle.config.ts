import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./.linchkit/drizzle-schema.generated.ts",
  out: "./drizzle/migrations",
  schemaFilter: ["public", "_linchkit"],
  // Required by db:push/db:pull; not needed for db:generate or programmatic migrate()
  ...(process.env.DATABASE_URL ? { dbCredentials: { url: process.env.DATABASE_URL } } : {}),
});
