/**
 * Real-browser e2e smoke suite.
 *
 * Drives the actual React UI (Vite dev server or any deployed instance)
 * through the system Chrome via puppeteer-core, against a running LinchKit
 * API server. Each test pins a wiring-class bug found in the 2026-06-10 live
 * testing wave that unit tests could not see:
 *
 *   a. blank app shell           — #533 (node:fs leak in the client barrel)
 *   b. "[object Object]" cells   — #537 (relation/object cell rendering)
 *   c. System Overview crash     — #538 (/health response shape)
 *   d. transition → bound Action — #536 (header buttons bypassed Actions)
 *   e. evolution run-cycle wired — #535/#541 (dev server evolutionRuntime)
 *   f. AI assistant configured   — #535 (dev server aiConfig wiring)
 *
 * Gated: the whole file self-skips unless LINCHKIT_E2E_BROWSER=1 so the
 * normal `bun run test` batch (which scans ./e2e/) stays green on machines
 * without Chrome or running servers. Use `bun run test:e2e` to execute.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Browser } from "puppeteer-core";
import {
  API_URL,
  BROWSER_E2E_ENABLED,
  describePageErrors,
  launchBrowser,
  newTrackedPage,
  UI_URL,
} from "./helpers/browser";

/** Per-test timeout for browser-driven cases (page loads + polling). */
const TEST_TIMEOUT_MS = 60_000;

/** Shape of one row of GET /api/executions. */
interface ExecutionItem {
  id: string;
  action: string;
  entity?: string;
  status: string;
  input?: Record<string, unknown>;
  stateTransition?: { from: string; to: string };
}

/** Envelope of GET /api/executions. */
interface ExecutionsResponse {
  success: boolean;
  data?: { items: ExecutionItem[]; total: number };
}

/**
 * Query the execution log, optionally filtered by action name. Transient
 * failures (non-200, network error) yield [] so polling call sites retry
 * until their own deadline instead of failing the whole test on one blip.
 */
async function fetchExecutions(action?: string): Promise<ExecutionItem[]> {
  const qs = action ? `?action=${encodeURIComponent(action)}&pageSize=50` : "?pageSize=50";
  try {
    const res = await fetch(`${API_URL}/api/executions${qs}`);
    if (res.status !== 200) return [];
    const body = (await res.json()) as ExecutionsResponse;
    return body.data?.items ?? [];
  } catch {
    return [];
  }
}

describe.skipIf(!BROWSER_E2E_ENABLED)("browser e2e smoke", () => {
  let browser: Browser;

  beforeAll(async () => {
    // Guard: bun may still run hooks of a skipped describe in some versions —
    // never launch Chrome unless the suite is actually enabled.
    if (!BROWSER_E2E_ENABLED) return;
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await browser?.close();
  });

  // ── a. App shell loads non-blank (pins #533 blank-page class) ──────────
  test(
    "app shell renders a non-blank page with zero uncaught page errors",
    async () => {
      const { page, pageErrors } = await newTrackedPage(browser);
      try {
        await page.goto(`${UI_URL}/`, { waitUntil: "networkidle2" });
        // The sidebar Home link is part of the app shell — present on every
        // route once the React tree mounts.
        await page.waitForSelector('a[href="/"]', { timeout: 20_000 });

        const bodyTextLength = await page.evaluate(() => document.body.innerText.trim().length);
        // A blank/white page renders ~0 chars; the real shell renders the
        // sidebar + workspace content (hundreds of chars). 200 is a safe floor
        // that tolerates demo-data variance.
        expect(bodyTextLength).toBeGreaterThan(200);
        expect(pageErrors, `uncaught page errors: ${describePageErrors(pageErrors)}`).toHaveLength(
          0,
        );
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // ── b. Entity list renders real labels (pins #537 [object Object]) ─────
  test(
    "purchase_request list renders rows without [object Object] cells",
    async () => {
      const { page, pageErrors } = await newTrackedPage(browser);
      try {
        await page.goto(`${UI_URL}/entities/purchase_request`, { waitUntil: "networkidle2" });
        await page.waitForSelector("table tbody tr", { timeout: 20_000 });

        const { rowCount, badCells, bodyHasObjectObject } = await page.evaluate(() => {
          const rows = Array.from(document.querySelectorAll("table tbody tr"));
          const cells = Array.from(document.querySelectorAll("table tbody td"));
          const bad = cells
            .map((cell) => (cell.textContent ?? "").trim())
            .filter((text) => text.includes("[object Object]"));
          return {
            rowCount: rows.length,
            badCells: bad,
            bodyHasObjectObject: document.body.innerText.includes("[object Object]"),
          };
        });

        expect(rowCount).toBeGreaterThanOrEqual(1);
        expect(badCells, `cells rendered as [object Object]: ${badCells.join(", ")}`).toHaveLength(
          0,
        );
        expect(bodyHasObjectObject).toBe(false);
        expect(pageErrors, `uncaught page errors: ${describePageErrors(pageErrors)}`).toHaveLength(
          0,
        );
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // ── c. System Overview renders without crashing (pins #538) ────────────
  test(
    "System Overview page renders without error boundary or page errors",
    async () => {
      const { page, pageErrors } = await newTrackedPage(browser);
      try {
        await page.goto(`${UI_URL}/admin/system`, { waitUntil: "networkidle2" });
        // The metrics grid is the page's core content; waiting for its label
        // proves the data-driven section rendered (not just the shell).
        await page.waitForFunction(() => document.body.innerText.includes("Registered Entities"), {
          timeout: 20_000,
        });

        const bodyText = await page.evaluate(() => document.body.innerText);
        // "Something went wrong" is the app's ErrorBoundary fallback title
        // (addons/adapter-ui/cap-adapter-ui/src/components/error-boundary.tsx).
        expect(bodyText).not.toContain("Something went wrong");
        expect(pageErrors, `uncaught page errors: ${describePageErrors(pageErrors)}`).toHaveLength(
          0,
        );
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // ── d. Transition button dispatches the BOUND action (pins #536) ───────
  test(
    "clicking the Submit transition dispatches submit_purchase_request, not a generic update",
    async () => {
      // Create a fresh draft record via the API so the test never depends on
      // pre-existing demo data being in a clickable state.
      const title = `E2E transition ${Date.now()}`;
      const createRes = await fetch(`${API_URL}/api/actions/create_purchase_request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          amount: 99,
          requester_email: "e2e-smoke@example.com",
        }),
      });
      expect(createRes.status).toBe(200);
      const created = (await createRes.json()) as {
        success: boolean;
        data?: { id: string; status: string };
      };
      expect(created.success).toBe(true);
      const recordId = created.data?.id;
      if (!recordId) throw new Error("create_purchase_request returned no record id");
      expect(created.data?.status).toBe("draft");

      const { page, pageErrors } = await newTrackedPage(browser);
      try {
        await page.goto(`${UI_URL}/entities/purchase_request/${recordId}`, {
          waitUntil: "networkidle2",
        });

        // The header transition button is labeled from the bound action
        // ("Submit for Approval" in the demo); match on /submit/i so a label
        // tweak doesn't break the suite.
        await page.waitForFunction(
          () =>
            Array.from(document.querySelectorAll("button")).some((b) =>
              /submit/i.test(b.textContent ?? ""),
            ),
          { timeout: 20_000 },
        );
        const clickedLabel = await page.evaluate(() => {
          const button = Array.from(document.querySelectorAll("button")).find((b) =>
            /submit/i.test(b.textContent ?? ""),
          );
          if (!button) return null;
          button.click();
          return (button.textContent ?? "").trim();
        });
        expect(clickedLabel).not.toBeNull();

        // Poll the execution log until the BOUND action shows up for this
        // record. A bypassing implementation (#536) would log only a generic
        // update with no state transition.
        let matched: ExecutionItem | undefined;
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline && !matched) {
          const items = await fetchExecutions("submit_purchase_request");
          matched = items.find(
            (item) => item.input?.id === recordId && item.status === "succeeded",
          );
          if (!matched) await new Promise((resolve) => setTimeout(resolve, 1_000));
        }

        expect(
          matched,
          "no succeeded submit_purchase_request execution recorded for the clicked record",
        ).toBeDefined();
        expect(matched?.action).toBe("submit_purchase_request");
        // The state machine transition proves the click went through the bound
        // Action (draft → pending), not a raw field write.
        expect(matched?.stateTransition).toEqual({ from: "draft", to: "pending" });

        // And the click must NOT have gone through the generic CRUD update.
        const updates = await fetchExecutions("update_purchase_request");
        const strayUpdate = updates.find((item) => item.input?.id === recordId);
        expect(
          strayUpdate,
          "transition click was routed through generic update_purchase_request",
        ).toBeUndefined();

        expect(pageErrors, `uncaught page errors: ${describePageErrors(pageErrors)}`).toHaveLength(
          0,
        );
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // ── e. Evolution on-demand cycle is wired (pins #535/#541) ─────────────
  // Asserts the post-#541 contract: the dev server wires an evolutionRuntime,
  // so the on-demand cycle returns 200 with counters (501 = not wired).
  // Additionally excludable via LINCHKIT_E2E_EVOLUTION=0 while #541 lands.
  test.skipIf(process.env.LINCHKIT_E2E_EVOLUTION === "0")(
    "POST /api/evolution/run-cycle returns 200 with cycle counters",
    async () => {
      const res = await fetch(`${API_URL}/api/evolution/run-cycle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(
        res.status,
        "501 means the server's evolutionRuntime is not wired (the #535 dev-server gap; fixed by #541)",
      ).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        data?: { created: number; deduped: number; total: number; createdIds: string[] };
      };
      expect(body.success).toBe(true);
      expect(typeof body.data?.created).toBe("number");
      expect(typeof body.data?.deduped).toBe("number");
      expect(typeof body.data?.total).toBe("number");
      expect(Array.isArray(body.data?.createdIds)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  // ── f. AI assistant reachability (pins #535 aiConfig wiring) ───────────
  // Needs a real provider key — opt-in via LINCHKIT_E2E_AI=1.
  test.skipIf(process.env.LINCHKIT_E2E_AI !== "1")(
    "POST /api/ai/chat does not return the 'AI service is not configured' 503",
    async () => {
      // The endpoint speaks the Vercel AI SDK UIMessage format: each message
      // carries a `parts` array (a flat `content` string is rejected).
      const res = await fetch(`${API_URL}/api/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", parts: [{ type: "text", text: "Reply with OK only." }] }],
        }),
      });
      // 503 is the specific "AI service is not configured" failure this test
      // pins; any 2xx (SSE stream) proves the provider wiring is live.
      expect(res.status).not.toBe(503);
      expect(res.status).toBe(200);
      // Don't consume the whole SSE stream — headers are enough.
      await res.body?.cancel();
    },
    TEST_TIMEOUT_MS,
  );

  // ── g. AG-UI run endpoint is mounted on the main server (#89) ──────────
  // Pins the cap-adapter-ag-ui wiring: the route only exists when the
  // capability is registered (config/capabilities.ts) AND adapter-server
  // mounts it (routes/agui-api.ts). The FIRST SSE event must be RUN_STARTED
  // — it is emitted before any provider call, so this holds even when the
  // configured AI key cannot complete a run (which would follow as
  // RUN_ERROR, after the frame this test asserts).
  test(
    "POST /api/agui/run streams SSE whose first event is RUN_STARTED",
    async () => {
      const res = await fetch(`${API_URL}/api/agui/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: "e2e_thread",
          runId: "e2e_run",
          messages: [{ id: "m1", role: "user", content: "Reply with OK only." }],
          tools: [],
          context: [],
        }),
      });
      // 404 = route not mounted (capability/wiring gap); 503 = AI not
      // configured on the dev server. Both are the regressions this pins.
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      // Read only the first SSE frame, then cancel — no full-run dependency.
      const reader = res.body?.getReader();
      expect(reader).toBeDefined();
      if (!reader) return;
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += new TextDecoder().decode(value);
        if (buffer.includes("\n\n")) break;
      }
      await reader.cancel();

      const firstFrame = buffer.split("\n\n")[0] ?? "";
      expect(firstFrame.startsWith("data: ")).toBe(true);
      const firstEvent = JSON.parse(firstFrame.slice("data: ".length)) as {
        type: string;
        threadId?: string;
        runId?: string;
      };
      expect(firstEvent.type).toBe("RUN_STARTED");
      expect(firstEvent.threadId).toBe("e2e_thread");
      expect(firstEvent.runId).toBe("e2e_run");
    },
    TEST_TIMEOUT_MS,
  );
});
