import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import type { DeployEvent } from "../src/deployment";
import { DeployWebhookHandler } from "../src/deployment";

// ── Helpers ─────────────────────────────────────────────────

const SECRET = "test-webhook-secret-abc";

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

function makePushPayload(
  opts: {
    branch?: string;
    commitSha?: string;
    login?: string;
    repo?: string;
    deleted?: boolean;
  } = {},
): string {
  return JSON.stringify({
    ref: `refs/heads/${opts.branch ?? "main"}`,
    after: opts.commitSha ?? "abc123def456",
    deleted: opts.deleted ?? false,
    sender: { login: opts.login ?? "alice" },
    repository: { full_name: opts.repo ?? "owner/repo" },
    head_commit: {
      id: opts.commitSha ?? "abc123def456",
      timestamp: "2026-05-18T09:00:00Z",
    },
  });
}

// ── Constructor validation ────────────────────────────────────

describe("DeployWebhookHandler constructor", () => {
  it("throws when secret is empty", () => {
    expect(
      () =>
        new DeployWebhookHandler({
          secret: "",
          onDeploy: async () => {},
        }),
    ).toThrow("secret is required");
  });

  it("throws when onDeploy is missing", () => {
    expect(
      () =>
        new DeployWebhookHandler({
          secret: SECRET,
          // biome-ignore lint/suspicious/noExplicitAny: intentional bad input
          onDeploy: undefined as any,
        }),
    ).toThrow("onDeploy callback is required");
  });

  it("uses 'main' as default branchFilter", async () => {
    const events: DeployEvent[] = [];
    const handler = new DeployWebhookHandler({
      secret: SECRET,
      onDeploy: async (e) => {
        events.push(e);
      },
    });

    const body = makePushPayload({ branch: "main" });
    await handler.handle(body, sign(body), "push");

    expect(events).toHaveLength(1);
  });
});

// ── verifySignature ──────────────────────────────────────────

describe("verifySignature", () => {
  const handler = new DeployWebhookHandler({
    secret: SECRET,
    onDeploy: async () => {},
  });

  it("returns true for correct signature", () => {
    const body = `{"ref":"refs/heads/main"}`;
    expect(handler.verifySignature(body, sign(body))).toBe(true);
  });

  it("returns false for wrong secret", () => {
    const body = `{"ref":"refs/heads/main"}`;
    expect(handler.verifySignature(body, sign(body, "wrong-secret"))).toBe(false);
  });

  it("returns false for tampered body", () => {
    const body = `{"ref":"refs/heads/main"}`;
    const sig = sign(body);
    expect(handler.verifySignature(`{"ref":"refs/heads/evil"}`, sig)).toBe(false);
  });

  it("returns false for empty signature", () => {
    const body = `{"ref":"refs/heads/main"}`;
    expect(handler.verifySignature(body, "")).toBe(false);
  });

  it("returns false for missing sha256= prefix (raw hex only)", () => {
    const body = `{"ref":"refs/heads/main"}`;
    const rawHex = createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
    expect(handler.verifySignature(body, rawHex)).toBe(false);
  });
});

// ── handle — event type filtering ────────────────────────────

describe("handle — event type filtering", () => {
  const handler = new DeployWebhookHandler({
    secret: SECRET,
    onDeploy: async () => {},
  });

  it("rejects non-push events with accepted=false", async () => {
    const body = makePushPayload();
    const result = await handler.handle(body, sign(body), "pull_request");

    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("pull_request");
  });

  it("rejects ping events", async () => {
    const body = JSON.stringify({ zen: "Non-blocking is better than blocking." });
    const result = await handler.handle(body, sign(body), "ping");

    expect(result.accepted).toBe(false);
  });
});

// ── handle — branch filtering ────────────────────────────────

describe("handle — branch filtering", () => {
  it("accepts push to the configured branch", async () => {
    const fired: DeployEvent[] = [];
    const handler = new DeployWebhookHandler({
      secret: SECRET,
      onDeploy: async (e) => {
        fired.push(e);
      },
    });

    const body = makePushPayload({ branch: "main" });
    const result = await handler.handle(body, sign(body), "push");

    expect(result.accepted).toBe(true);
    expect(fired).toHaveLength(1);
  });

  it("ignores push to a different branch", async () => {
    const fired: DeployEvent[] = [];
    const handler = new DeployWebhookHandler({
      secret: SECRET,
      onDeploy: async (e) => {
        fired.push(e);
      },
    });

    const body = makePushPayload({ branch: "feature/xyz" });
    const result = await handler.handle(body, sign(body), "push");

    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("feature/xyz");
    expect(fired).toHaveLength(0);
  });

  it("respects custom branchFilter", async () => {
    const fired: DeployEvent[] = [];
    const handler = new DeployWebhookHandler({
      secret: SECRET,
      branchFilter: "production",
      onDeploy: async (e) => {
        fired.push(e);
      },
    });

    const body = makePushPayload({ branch: "production" });
    const result = await handler.handle(body, sign(body), "push");

    expect(result.accepted).toBe(true);
    expect(fired).toHaveLength(1);

    const mainBody = makePushPayload({ branch: "main" });
    const mainResult = await handler.handle(mainBody, sign(mainBody), "push");
    expect(mainResult.accepted).toBe(false);
  });

  it("ignores branch deletion events", async () => {
    const fired: DeployEvent[] = [];
    const handler = new DeployWebhookHandler({
      secret: SECRET,
      onDeploy: async (e) => {
        fired.push(e);
      },
    });

    const body = makePushPayload({ branch: "main", deleted: true });
    const result = await handler.handle(body, sign(body), "push");

    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("deletion");
    expect(fired).toHaveLength(0);
  });
});

// ── handle — signature failure ────────────────────────────────

describe("handle — signature failure", () => {
  const handler = new DeployWebhookHandler({
    secret: SECRET,
    onDeploy: async () => {
      throw new Error("should not be called");
    },
  });

  it("returns accepted=false and reason=invalid signature", async () => {
    const body = makePushPayload();
    const result = await handler.handle(body, "sha256=deadbeef", "push");

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe("invalid signature");
  });

  it("does NOT fire onDeploy when signature is wrong", async () => {
    const body = makePushPayload();
    // No throw means onDeploy was never called
    const result = await handler.handle(body, "sha256=bad", "push");
    expect(result.accepted).toBe(false);
  });
});

// ── handle — JSON parsing failure ────────────────────────────

describe("handle — malformed payload", () => {
  const handler = new DeployWebhookHandler({
    secret: SECRET,
    onDeploy: async () => {},
  });

  it("returns accepted=false for invalid JSON", async () => {
    const body = "not-valid-json";
    const result = await handler.handle(body, sign(body), "push");

    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("invalid JSON");
  });
});

// ── handle — DeployEvent shape ────────────────────────────────

describe("handle — DeployEvent payload", () => {
  it("maps push payload fields to DeployEvent correctly", async () => {
    const captured: DeployEvent[] = [];
    const handler = new DeployWebhookHandler({
      secret: SECRET,
      onDeploy: async (e) => {
        captured.push(e);
      },
    });

    const body = makePushPayload({
      branch: "main",
      commitSha: "deadbeefcafe1234",
      login: "deployer-bot",
      repo: "acme/my-app",
    });

    await handler.handle(body, sign(body), "push");

    expect(captured).toHaveLength(1);
    const ev = captured[0] as DeployEvent;
    expect(ev.branch).toBe("main");
    expect(ev.commitSha).toBe("deadbeefcafe1234");
    expect(ev.pushedBy).toBe("deployer-bot");
    expect(ev.repository).toBe("acme/my-app");
    expect(ev.timestamp).toBe("2026-05-18T09:00:00Z");
  });
});

// ── handle — callback error propagation ──────────────────────

describe("handle — onDeploy error propagation", () => {
  it("propagates errors from onDeploy to the caller", async () => {
    const handler = new DeployWebhookHandler({
      secret: SECRET,
      onDeploy: async () => {
        throw new Error("deployment failed");
      },
    });

    const body = makePushPayload();
    await expect(handler.handle(body, sign(body), "push")).rejects.toThrow("deployment failed");
  });
});
