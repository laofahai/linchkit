/**
 * Shared helpers for the real-browser e2e smoke suite.
 *
 * Drives the system Chrome/Chromium via puppeteer-core (no bundled browser
 * download). Playwright is intentionally NOT used — it is incompatible with
 * the Bun test runner on this project.
 */

import { existsSync } from "node:fs";
import puppeteer, { type Browser, type BrowserContext, type Page } from "puppeteer-core";

/** Base URL of the Vite dev UI (React SPA). */
export const UI_URL = process.env.LINCHKIT_E2E_UI_URL ?? "http://localhost:3000";

/** Base URL of the LinchKit API server (Elysia). */
export const API_URL = process.env.LINCHKIT_E2E_API_URL ?? "http://localhost:3001";

/** Master gate: browser e2e only runs when explicitly enabled. */
export const BROWSER_E2E_ENABLED = process.env.LINCHKIT_E2E_BROWSER === "1";

/** Known Chrome/Chromium install locations, probed in order. */
const CHROME_CANDIDATES = [
  // macOS default
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  // Linux candidates
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
];

/**
 * Resolve the Chrome executable path.
 * `LINCHKIT_CHROME_PATH` wins; otherwise the first existing known location.
 */
export function resolveChromePath(): string {
  const fromEnv = process.env.LINCHKIT_CHROME_PATH;
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new Error(
        `LINCHKIT_CHROME_PATH is set to "${fromEnv}" but no executable exists there.`,
      );
    }
    return fromEnv;
  }
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "No Chrome/Chromium executable found. Set LINCHKIT_CHROME_PATH to your browser binary " +
      `(probed: ${CHROME_CANDIDATES.join(", ")}).`,
  );
}

/** Launch a headless browser against the system Chrome. */
export async function launchBrowser(): Promise<Browser> {
  return puppeteer.launch({
    executablePath: resolveChromePath(),
    headless: true,
    // --no-sandbox keeps CI containers happy; --disable-dev-shm-usage avoids
    // tiny /dev/shm crashes in Docker.
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}

/** A page plus the uncaught in-page errors collected while driving it. */
export interface TrackedPage {
  page: Page;
  /**
   * The isolated browser context backing this page. Close it (not just the page)
   * when done so the next test starts from clean per-origin storage.
   */
  context: BrowserContext;
  /** Uncaught exceptions thrown inside the page ('pageerror' events). */
  pageErrors: Error[];
}

/**
 * Open a fresh page in its OWN incognito browser context that records every
 * uncaught in-page error.
 *
 * Each call gets an isolated `BrowserContext` (separate cookies, localStorage,
 * sessionStorage, service workers) rather than another tab on the shared default
 * context. The assistant's `useChat`/transport persists conversation + chat-id
 * state per origin, so a tab on the shared context would inherit the PREVIOUS
 * test's client state — which silently breaks the next test's fresh run (its new
 * interrupt card never renders). Isolated contexts make each test hermetic; the
 * caller must `context.close()` (closes its pages) in a `finally`.
 */
export async function newTrackedPage(browser: Browser): Promise<TrackedPage> {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(30_000);
  const pageErrors: Error[] = [];
  page.on("pageerror", (err) => {
    pageErrors.push(err instanceof Error ? err : new Error(String(err)));
  });
  return { page, context, pageErrors };
}

/** Format collected page errors for assertion messages. */
export function describePageErrors(errors: Error[]): string {
  return errors.map((e) => e.message).join(" | ");
}
