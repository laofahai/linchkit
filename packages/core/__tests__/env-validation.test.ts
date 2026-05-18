import { describe, expect, test } from "bun:test";
import { OPTIONAL_ENV_VARS, REQUIRED_ENV_VARS, validateEnv } from "../src/runtime/env";

describe("validateEnv", () => {
  test("ok=true when every required variable is present and non-empty", () => {
    const result = validateEnv({
      DATABASE_URL: "postgres://user:pw@localhost:5432/app",
      JWT_SECRET: "0123456789abcdef0123456789abcdef",
      NODE_ENV: "development",
    });

    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("ok=false and lists every missing required variable", () => {
    const result = validateEnv({ NODE_ENV: "development" });

    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([...REQUIRED_ENV_VARS]);
  });

  test("treats empty-string required values as missing", () => {
    const result = validateEnv({
      DATABASE_URL: "",
      JWT_SECRET: "",
    });

    expect(result.ok).toBe(false);
    expect(result.missing).toContain("DATABASE_URL");
    expect(result.missing).toContain("JWT_SECRET");
  });

  test("warns when NODE_ENV is unknown but does not fail validation", () => {
    const result = validateEnv({
      DATABASE_URL: "postgres://localhost/db",
      JWT_SECRET: "0123456789abcdef0123456789abcdef",
      NODE_ENV: "banana",
    });

    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes("NODE_ENV"))).toBe(true);
  });

  test("warns about missing observability + cache vars in production", () => {
    const result = validateEnv({
      DATABASE_URL: "postgres://localhost/db",
      JWT_SECRET: "0123456789abcdef0123456789abcdef",
      NODE_ENV: "production",
    });

    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes("OTEL_EXPORTER_OTLP_ENDPOINT"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("REDIS_URL"))).toBe(true);
  });

  test("does not warn about optional vars in development", () => {
    const result = validateEnv({
      DATABASE_URL: "postgres://localhost/db",
      JWT_SECRET: "0123456789abcdef0123456789abcdef",
      NODE_ENV: "development",
    });

    expect(result.warnings.some((w) => w.includes("OTEL_EXPORTER_OTLP_ENDPOINT"))).toBe(false);
    expect(result.warnings.some((w) => w.includes("REDIS_URL"))).toBe(false);
  });

  test("warns when JWT_SECRET is shorter than 32 characters", () => {
    const result = validateEnv({
      DATABASE_URL: "postgres://localhost/db",
      JWT_SECRET: "short",
      NODE_ENV: "development",
    });

    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes("JWT_SECRET"))).toBe(true);
  });

  test("accepts missing NODE_ENV without warning", () => {
    const result = validateEnv({
      DATABASE_URL: "postgres://localhost/db",
      JWT_SECRET: "0123456789abcdef0123456789abcdef",
    });

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  test("REQUIRED_ENV_VARS and OPTIONAL_ENV_VARS export the documented surface", () => {
    expect(REQUIRED_ENV_VARS).toContain("DATABASE_URL");
    expect(REQUIRED_ENV_VARS).toContain("JWT_SECRET");
    expect(OPTIONAL_ENV_VARS).toContain("NODE_ENV");
    expect(OPTIONAL_ENV_VARS).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(OPTIONAL_ENV_VARS).toContain("REDIS_URL");
  });
});
