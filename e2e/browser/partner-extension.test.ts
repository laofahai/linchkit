/**
 * In-place capability extension — LIVE browser e2e (the Odoo `_inherit` proof).
 *
 * SKELETON — authored, NOT yet run. The orchestrator will run + refine this
 * against the real stack (see "RUN" note at the bottom of bootStack()).
 *
 * What it proves: cap-sales adds a `credit_limit` field to cap-partner's
 * `partner` entity + `partner_form` view IN PLACE (no fork), and that field
 * actually RENDERS in the live, schema-driven entity form — the visible payoff
 * of the headless guard in config/capabilities/__tests__/partner-extension.test.ts.
 *
 *   navigate to the partner create form (/entities/partner/new) →
 *   the form renders the cap-sales-injected `credit_limit` field →
 *   asserted via the form-field wrapper `[data-field="credit_limit"]`
 *   (set by addons/adapter-ui/.../auto-form/form-field.tsx) and its
 *   "Credit Limit" label.
 *
 * Boot harness mirrors e2e/browser/agui-hitl.test.ts: self-contained, on
 * dedicated ports (:3111 API / :3110 UI) so it never collides with a hand-run
 * dev server (:3001/:3000) or the HITL e2e (:3101/:3100). Drains child stdio so
 * the OS pipe buffer never fills and hangs the server mid-run. NEVER calls
 * `app.listen` in-process — it spawns the real `dev.ts` + Vite, same as HITL.
 *
 * Gated: self-skips unless LINCHKIT_E2E_BROWSER=1, so the normal `bun run test`
 * batch that scans ./e2e/ stays green on machines without Chrome.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import type { Browser } from "puppeteer-core";
import { BROWSER_E2E_ENABLED, launchBrowser, newTrackedPage } from "./helpers/browser";

// Dedicated ports so this never clobbers a hand-run dev server (:3001/:3000) or
// the HITL e2e (:3101/:3100).
const API_PORT = Number(process.env.LINCHKIT_E2E_PARTNER_API_PORT ?? 3111);
const UI_PORT = Number(process.env.LINCHKIT_E2E_PARTNER_UI_PORT ?? 3110);
const API_URL = `http://localhost:${API_PORT}`;
const UI_URL = `http://localhost:${UI_PORT}`;

/** The schema-driven create-form route for the `partner` entity (see app.tsx). */
const PARTNER_FORM_PATH = "/entities/partner/new";

/** Booting Vite + the server is slow; give generous per-test + boot budgets. */
const TEST_TIMEOUT_MS = 120_000;
const BOOT_TIMEOUT_MS = 90_000;

// ── server + UI boot (self-contained) ───────────────────────────────────────

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return; // up (404 = served but no such route)
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Timed out waiting for ${url} after ${timeoutMs}ms`);
}

interface BootedStack {
  server: Subprocess;
  ui: Subprocess;
}

/**
 * Continuously drain a spawned child's stdout/stderr so its OS pipe buffer never
 * fills. A child spawned with `stdout: "pipe"` whose pipe is never read BLOCKS on
 * its next write once the ~64 KB buffer fills (see agui-hitl.test.ts for the full
 * rationale). Fire-and-forget; swallow errors (the stream closes on child exit).
 */
function drainStream(stream: ReadableStream<Uint8Array> | null | undefined): void {
  if (!stream) return;
  void (async () => {
    try {
      const reader = stream.getReader();
      while (!(await reader.read()).done) {
        // discard — we only need the pipe emptied, not the contents
      }
    } catch {
      // child exited / stream errored — nothing to drain
    }
  })();
}

/**
 * Boot the API server + the Vite UI, each on a dedicated port. The UI dev server
 * proxies `/api`, `/graphql`, `/health` to the API server (vite.config.ts reads
 * LINCHKIT_UI_PROXY_TARGET), so the entity form's schema-bundle fetch reaches OUR
 * API port. No model stub is needed — this test never touches the AI/AG-UI path.
 *
 * RUN (orchestrator): `LINCHKIT_E2E_BROWSER=1 bun test ./e2e/browser/partner-extension.test.ts`
 * with a system Chrome present (LINCHKIT_CHROME_PATH or a default location).
 */
async function bootStack(): Promise<BootedStack> {
  const baseEnv = {
    ...process.env,
    // Match the HITL harness: an explicit dev marker so the spawned server wires
    // its dev store/feature behavior exactly as `bun run dev:server` does.
    BUN_ENV: "development",
  };

  // Boot the API server on an isolated port. Disable its auto-started UI + MCP
  // child transports so THIS test owns the UI port (no auto-vite-port drift) and
  // there is no :3002 MCP collision with a hand-run dev server.
  const server = Bun.spawn(["bun", "addons/adapter-server/cap-adapter-server/src/dev.ts"], {
    env: {
      ...baseEnv,
      PORT: String(API_PORT),
      HOST: "127.0.0.1",
      LINCHKIT_DEV_DISABLE_TRANSPORTS: "ui,mcp",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  // Drain immediately — an unread pipe buffer fills and HANGS the server mid-run.
  drainStream(server.stdout as ReadableStream<Uint8Array>);
  drainStream(server.stderr as ReadableStream<Uint8Array>);
  await waitForUrl(`${API_URL}/health`, BOOT_TIMEOUT_MS);

  // Boot the Vite UI in the UI package dir on our isolated port with --strictPort
  // so it never silently drifts. LINCHKIT_UI_PROXY_TARGET points its proxy at OUR
  // API port instead of the default :3001.
  const ui = Bun.spawn(
    ["bunx", "vite", "--configLoader", "runner", "--port", String(UI_PORT), "--strictPort"],
    {
      cwd: "addons/adapter-ui/cap-adapter-ui",
      env: { ...baseEnv, LINCHKIT_UI_PROXY_TARGET: API_URL },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  drainStream(ui.stdout as ReadableStream<Uint8Array>);
  drainStream(ui.stderr as ReadableStream<Uint8Array>);
  await waitForUrl(UI_URL, BOOT_TIMEOUT_MS);

  return { server, ui };
}

function killStack(stack: BootedStack | undefined): void {
  stack?.server.kill();
  stack?.ui.kill();
}

describe.skipIf(!BROWSER_E2E_ENABLED)("partner in-place extension browser e2e", () => {
  let browser: Browser;
  let stack: BootedStack | undefined;

  beforeAll(async () => {
    if (!BROWSER_E2E_ENABLED) return;
    stack = await bootStack();
    browser = await launchBrowser();
  }, BOOT_TIMEOUT_MS + 10_000);

  afterAll(async () => {
    await browser?.close();
    killStack(stack);
  });

  test(
    "the cap-sales credit_limit field renders on the partner create form",
    async () => {
      const { page, context, pageErrors } = await newTrackedPage(browser);
      try {
        // Navigate straight to the schema-driven partner create form. The page
        // (EntityFormPage) fetches the entity bundle from the API and renders the
        // `partner_form` view — which now carries the cap-sales-injected field.
        await page.goto(`${UI_URL}${PARTNER_FORM_PATH}`, { waitUntil: "networkidle2" });

        // The form-field wrapper carries `data-field="<field>"` (form-field.tsx),
        // so the injected `credit_limit` field appears as `[data-field="credit_limit"]`.
        // This is the authoritative proof that the IN-PLACE extension reached the UI.
        await page.waitForSelector('[data-field="credit_limit"]', { timeout: 30_000 });

        const found = await page.evaluate(() => {
          const wrapper = document.querySelector('[data-field="credit_limit"]');
          // The form-field label cell renders the field's "Credit Limit" label.
          const labelHit = Array.from(document.querySelectorAll("label")).some((l) =>
            (l.textContent ?? "").includes("Credit Limit"),
          );
          return { hasWrapper: !!wrapper, hasLabel: labelHit };
        });
        expect(found.hasWrapper).toBe(true);
        expect(found.hasLabel).toBe(true);

        // The base fields must still render (the extension AUGMENTS, not replaces).
        const hasName = await page.$('[data-field="name"]');
        expect(
          hasName,
          "base `name` field missing — extension should augment, not fork",
        ).not.toBeNull();

        expect(pageErrors.map((e) => e.message)).toHaveLength(0);
      } finally {
        await context.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
