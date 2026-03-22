import { describe, expect, test } from "bun:test";
import type { ActionContext } from "@linchkit/core";
import { createDevAuthProvider } from "../src/providers/dev-provider";

// Minimal stub for ActionContext — only the shape needed by the provider
const stubCtx = {} as ActionContext;

describe("DevAuthProvider", () => {
  const provider = createDevAuthProvider();

  test("login returns tokens for known user", async () => {
    const result = await provider.login(stubCtx, {
      email: "admin@linchkit.dev",
      password: "anything",
    });

    expect(result.access_token).toBeTruthy();
    expect(result.refresh_token).toBeTruthy();
    expect(result.expires_in).toBeGreaterThan(0);
  });

  test("login throws for unknown user", async () => {
    await expect(
      provider.login(stubCtx, { email: "nobody@linchkit.dev", password: "x" }),
    ).rejects.toThrow("Unknown user");
  });

  test("login + resolveToken round-trip returns correct actor", async () => {
    const loginResult = await provider.login(stubCtx, {
      email: "admin@linchkit.dev",
      password: "dev",
    });

    const actor = await provider.resolveToken(loginResult.access_token);
    expect(actor).not.toBeNull();
    expect(actor?.id).toBe("admin");
    expect(actor?.name).toBe("admin@linchkit.dev");
    expect(actor?.groups).toEqual(["admin"]);
    expect(actor?.type).toBe("human");
  });

  test("login + resolveToken round-trip for regular user", async () => {
    const loginResult = await provider.login(stubCtx, {
      email: "user@linchkit.dev",
      password: "whatever",
    });

    const actor = await provider.resolveToken(loginResult.access_token);
    expect(actor).not.toBeNull();
    expect(actor?.id).toBe("user1");
    expect(actor?.groups).toEqual(["user"]);
  });

  test("resolveToken returns null for garbage token", async () => {
    const actor = await provider.resolveToken("not-a-valid-token");
    expect(actor).toBeNull();
  });

  test("resolveToken returns null for expired token", async () => {
    // Craft a token with exp in the past
    const payload = JSON.stringify({ userId: "admin", email: "admin@linchkit.dev", exp: 0 });
    const expiredToken = btoa(payload);

    const actor = await provider.resolveToken(expiredToken);
    expect(actor).toBeNull();
  });

  test("refreshToken produces a new access token", async () => {
    const loginResult = await provider.login(stubCtx, {
      email: "admin@linchkit.dev",
      password: "dev",
    });

    const refreshResult = await provider.refreshToken(stubCtx, {
      refresh_token: loginResult.refresh_token,
    });

    expect(refreshResult.access_token).toBeTruthy();
    expect(refreshResult.expires_at).toBeTruthy();

    // The new access token should resolve correctly
    const actor = await provider.resolveToken(refreshResult.access_token);
    expect(actor).not.toBeNull();
    expect(actor?.id).toBe("admin");
  });

  test("resolveApiKey returns null (not supported)", async () => {
    const result = await provider.resolveApiKey("lk_anything");
    expect(result).toBeNull();
  });

  test("resolveSession returns null (not supported)", async () => {
    const result = await provider.resolveSession("some-session-id");
    expect(result).toBeNull();
  });

  test("logout is a no-op (does not throw)", async () => {
    await expect(provider.logout(stubCtx, {})).resolves.toBeUndefined();
  });

  test("resetPassword returns success", async () => {
    const result = await provider.resetPassword(stubCtx, { email: "admin@linchkit.dev" });
    expect(result.success).toBe(true);
  });
});
