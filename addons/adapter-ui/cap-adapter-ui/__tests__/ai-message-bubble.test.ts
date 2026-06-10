/**
 * Tests for the navigateTo link guard in ai-message-bubble.tsx.
 *
 * The navigateTo tool result used to render `input.path` directly as an
 * <a href> — an XSS / open-redirect sink if a model ever emits
 * `javascript:...` or an absolute external URL. `isAppRelativePath` gates
 * link rendering: only app-relative paths ("/..." but not "//...") become
 * an href; everything else renders as plain text.
 *
 * Logic-only test (no jsdom), matching the pattern of ai-assistant.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { isAppRelativePath } from "../src/components/ai-message-bubble";

describe("isAppRelativePath", () => {
  test("accepts an app-relative path", () => {
    expect(isAppRelativePath("/admin/x")).toBe(true);
    expect(isAppRelativePath("/")).toBe(true);
    expect(isAppRelativePath("/admin/orders?page=2#top")).toBe(true);
  });

  test("rejects a protocol-relative URL", () => {
    expect(isAppRelativePath("//evil.com")).toBe(false);
    expect(isAppRelativePath("//evil.com/admin")).toBe(false);
  });

  test("rejects a javascript: URL", () => {
    expect(isAppRelativePath("javascript:alert(1)")).toBe(false);
    expect(isAppRelativePath("JavaScript:alert(1)")).toBe(false);
  });

  test("rejects absolute external URLs", () => {
    expect(isAppRelativePath("https://x")).toBe(false);
    expect(isAppRelativePath("http://example.com/admin")).toBe(false);
    expect(isAppRelativePath("data:text/html,<script>1</script>")).toBe(false);
  });

  test("rejects relative (non-rooted) paths", () => {
    expect(isAppRelativePath("relative")).toBe(false);
    expect(isAppRelativePath("./admin")).toBe(false);
    expect(isAppRelativePath("")).toBe(false);
  });
});
