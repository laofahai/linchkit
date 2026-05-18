/**
 * GitHub Deployment Webhook Handler — Spec 12 §3
 *
 * Receives GitHub push/PR-merge webhook events, verifies the HMAC-SHA256
 * signature, and fires a configurable deployment callback when a push to
 * the watched branch (default: "main") is detected.
 *
 * Security: timing-safe signature comparison prevents timing-oracle attacks.
 * The handler NEVER executes shell commands itself; it delegates to the
 * `onDeploy` callback supplied by the server-layer so the logic is testable
 * in isolation and the actual deployment strategy can evolve independently.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

// ── Public types ─────────────────────────────────────────────

/** Summary of the inbound push event, passed to the deploy callback. */
export interface DeployEvent {
  /** Destination branch name (e.g. "main") */
  branch: string;
  /** HEAD commit SHA after the push */
  commitSha: string;
  /** GitHub login that triggered the push */
  pushedBy: string;
  /** Repository full name, e.g. "owner/repo" */
  repository: string;
  /** ISO-8601 timestamp from the GitHub payload */
  timestamp: string;
}

/** Options for constructing a DeployWebhookHandler. */
export interface DeployWebhookConfig {
  /**
   * GitHub webhook secret used to compute the expected HMAC-SHA256.
   * Must match the secret configured in the GitHub repository settings.
   */
  secret: string;
  /**
   * Only fire `onDeploy` when the push targets this branch.
   * Default: "main".
   */
  branchFilter?: string;
  /**
   * Called when a qualifying push event passes signature verification.
   * Implement git-pull → bun-install → bun-build → blue-green-switch here.
   */
  onDeploy: (event: DeployEvent) => Promise<void>;
}

/** Outcome of processing a single webhook request. */
export interface WebhookHandleResult {
  /** true = accepted and onDeploy was invoked (or will be) */
  accepted: boolean;
  /** Human-readable reason when accepted is false */
  reason?: string;
}

// ── Internal helpers ─────────────────────────────────────────

/** Raw shape of a GitHub push event payload (only the fields we use). */
interface GitHubPushPayload {
  ref?: string;
  after?: string;
  sender?: { login?: string };
  repository?: { full_name?: string };
  head_commit?: { id?: string; timestamp?: string };
  // null when the branch is deleted (after = "0000000000000000000000000000000000000000")
  created?: boolean;
  deleted?: boolean;
}

function computeExpectedSignature(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

function safeEqual(a: string, b: string): boolean {
  // Convert both to Buffer so timingSafeEqual can be used regardless of length
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ── DeployWebhookHandler ─────────────────────────────────────

export class DeployWebhookHandler {
  private readonly secret: string;
  private readonly branchFilter: string;
  private readonly onDeploy: (event: DeployEvent) => Promise<void>;

  constructor(config: DeployWebhookConfig) {
    if (!config.secret) {
      throw new Error("DeployWebhookHandler: secret is required");
    }
    if (!config.onDeploy) {
      throw new Error("DeployWebhookHandler: onDeploy callback is required");
    }
    this.secret = config.secret;
    this.branchFilter = config.branchFilter ?? "main";
    this.onDeploy = config.onDeploy;
  }

  /**
   * Verify the HMAC-SHA256 signature on a raw webhook body.
   *
   * @param rawBody - The raw (un-parsed) request body string
   * @param signature - Value of the `X-Hub-Signature-256` header
   */
  verifySignature(rawBody: string, signature: string): boolean {
    if (!signature) return false;
    const expected = computeExpectedSignature(this.secret, rawBody);
    return safeEqual(expected, signature);
  }

  /**
   * Process a GitHub webhook request.
   *
   * @param rawBody - Raw JSON string from the request body
   * @param signature - Value of `X-Hub-Signature-256` header
   * @param eventType - Value of `X-GitHub-Event` header (e.g. "push")
   * @returns Result indicating whether the deploy callback was fired
   */
  async handle(
    rawBody: string,
    signature: string,
    eventType: string,
  ): Promise<WebhookHandleResult> {
    // 1. Verify signature
    if (!this.verifySignature(rawBody, signature)) {
      return { accepted: false, reason: "invalid signature" };
    }

    // 2. Only handle push events (PR merges arrive as push events to the target branch)
    if (eventType !== "push") {
      return { accepted: false, reason: `event type "${eventType}" is not handled` };
    }

    // 3. Parse payload
    let payload: GitHubPushPayload;
    try {
      payload = JSON.parse(rawBody) as GitHubPushPayload;
    } catch {
      return { accepted: false, reason: "invalid JSON payload" };
    }

    // 4. Check branch
    const refBranch = payload.ref?.replace("refs/heads/", "");
    if (refBranch !== this.branchFilter) {
      return {
        accepted: false,
        reason: `branch "${refBranch}" does not match filter "${this.branchFilter}"`,
      };
    }

    // 5. Ignore branch deletions (after is all zeros)
    if (payload.deleted) {
      return { accepted: false, reason: "branch deletion event, skipping" };
    }

    // 6. Build deploy event
    const commitSha = payload.after ?? payload.head_commit?.id ?? "unknown";
    const pushedBy = payload.sender?.login ?? "unknown";
    const repository = payload.repository?.full_name ?? "unknown";
    const timestamp = payload.head_commit?.timestamp ?? new Date().toISOString();

    const event: DeployEvent = {
      branch: refBranch ?? this.branchFilter,
      commitSha,
      pushedBy,
      repository,
      timestamp,
    };

    // 7. Fire the deploy callback (errors propagate to caller for HTTP 500)
    await this.onDeploy(event);

    return { accepted: true };
  }
}
