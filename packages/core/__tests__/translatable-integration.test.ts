/**
 * Integration tests for i18n locale propagation
 *
 * Verifies that locale flows through the full stack:
 * - DataQueryOptions → DataProvider → translatable field resolution
 * - ActionEngine ExecuteOptions → DataQueryOptions
 * - CommandLayer → ActionEngine
 * - Accept-Language header parsing
 */

import { describe, expect, test } from "bun:test";
import type { DataProvider, DataQueryOptions } from "../src/engine/action-engine";
import { createActionExecutor } from "../src/engine/action-engine";
import { createCommandLayer } from "../src/engine/command-layer";
import type { ActionDefinition, Actor } from "../src/types/action";

// ── Accept-Language parsing (re-implemented locally to test the logic) ──

/**
 * Parse the primary locale from an Accept-Language header value.
 * Mirrors the implementation in cap-adapter-server/src/server.ts.
 */
function parseAcceptLanguage(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const first = header.split(/[,;]/)[0]?.trim();
  return first || undefined;
}

// ── Test fixtures ──────────────────────────────────────────

const TEST_ACTOR: Actor = { type: "system", id: "test", groups: [] };

/** Mock DataProvider that captures the options passed to get/query */
function createCapturingDataProvider(): DataProvider & {
  lastGetOptions: DataQueryOptions | undefined;
  lastQueryOptions: DataQueryOptions | undefined;
} {
  const provider = {
    lastGetOptions: undefined as DataQueryOptions | undefined,
    lastQueryOptions: undefined as DataQueryOptions | undefined,

    async get(
      _schema: string,
      _id: string,
      options?: DataQueryOptions,
    ): Promise<Record<string, unknown>> {
      provider.lastGetOptions = options;
      return { id: _id, name: { en: "Hello", "zh-CN": "你好" } };
    },

    async query(
      _schema: string,
      _filter: Record<string, unknown>,
      options?: DataQueryOptions,
    ): Promise<Array<Record<string, unknown>>> {
      provider.lastQueryOptions = options;
      return [{ id: "1", name: { en: "Hello", "zh-CN": "你好" } }];
    },

    async create(_schema: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
      return { id: "new_1", ...data };
    },

    async update(
      _schema: string,
      id: string,
      data: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      return { id, ...data };
    },

    async delete(_schema: string, _id: string): Promise<void> {},

    async count(): Promise<number> {
      return 1;
    },
  };
  return provider;
}

// ── Tests ──────────────────────────────────────────────────

describe("Accept-Language parsing", () => {
  test("returns undefined for null/undefined/empty", () => {
    expect(parseAcceptLanguage(null)).toBeUndefined();
    expect(parseAcceptLanguage(undefined)).toBeUndefined();
    expect(parseAcceptLanguage("")).toBeUndefined();
  });

  test("extracts single locale", () => {
    expect(parseAcceptLanguage("zh-CN")).toBe("zh-CN");
  });

  test("extracts first locale from comma-separated list", () => {
    expect(parseAcceptLanguage("zh-CN,en-US;q=0.9,en;q=0.8")).toBe("zh-CN");
  });

  test("extracts first locale before quality value", () => {
    expect(parseAcceptLanguage("en-US;q=0.9")).toBe("en-US");
  });

  test("handles whitespace", () => {
    expect(parseAcceptLanguage("  fr-FR , en-US ")).toBe("fr-FR");
  });

  test("handles wildcard", () => {
    expect(parseAcceptLanguage("*")).toBe("*");
  });
});

describe("ActionEngine locale propagation", () => {
  test("locale flows from ExecuteOptions to DataProvider.get()", async () => {
    const dp = createCapturingDataProvider();
    const executor = createActionExecutor({ dataProvider: dp });

    const fetchAction: ActionDefinition = {
      name: "fetch_item",
      schema: "items",
      label: "Fetch item",
      exposure: "all",
      handler: async (ctx) => {
        return ctx.get("items", "item_1");
      },
    };
    executor.registry.register(fetchAction);

    await executor.execute("fetch_item", {}, TEST_ACTOR, {
      channel: "http",
      locale: "zh-CN",
    });

    expect(dp.lastGetOptions).toBeDefined();
    expect(dp.lastGetOptions?.locale).toBe("zh-CN");
  });

  test("locale flows from ExecuteOptions to DataProvider.query()", async () => {
    const dp = createCapturingDataProvider();
    const executor = createActionExecutor({ dataProvider: dp });

    const listAction: ActionDefinition = {
      name: "list_items",
      schema: "items",
      label: "List items",
      exposure: "all",
      handler: async (ctx) => {
        return ctx.query("items", {});
      },
    };
    executor.registry.register(listAction);

    await executor.execute("list_items", {}, TEST_ACTOR, {
      channel: "http",
      locale: "en",
    });

    expect(dp.lastQueryOptions).toBeDefined();
    expect(dp.lastQueryOptions?.locale).toBe("en");
  });

  test("locale and tenantId coexist in DataQueryOptions", async () => {
    const dp = createCapturingDataProvider();
    const executor = createActionExecutor({ dataProvider: dp });

    const fetchAction: ActionDefinition = {
      name: "fetch_item2",
      schema: "items",
      label: "Fetch item",
      exposure: "all",
      handler: async (ctx) => {
        return ctx.get("items", "item_1");
      },
    };
    executor.registry.register(fetchAction);

    await executor.execute("fetch_item2", {}, TEST_ACTOR, {
      channel: "http",
      locale: "zh-CN",
      tenantId: "tenant_1",
    });

    expect(dp.lastGetOptions).toBeDefined();
    expect(dp.lastGetOptions?.locale).toBe("zh-CN");
    expect(dp.lastGetOptions?.tenantId).toBe("tenant_1");
  });

  test("no locale means undefined in DataQueryOptions", async () => {
    const dp = createCapturingDataProvider();
    const executor = createActionExecutor({ dataProvider: dp });

    const fetchAction: ActionDefinition = {
      name: "fetch_no_locale",
      schema: "items",
      label: "Fetch item",
      exposure: "all",
      handler: async (ctx) => {
        return ctx.get("items", "item_1");
      },
    };
    executor.registry.register(fetchAction);

    await executor.execute("fetch_no_locale", {}, TEST_ACTOR, {
      channel: "http",
    });

    // No locale and no tenantId => options is undefined
    expect(dp.lastGetOptions).toBeUndefined();
  });
});

describe("CommandLayer locale propagation", () => {
  test("locale passes through CommandLayer to executor", async () => {
    const dp = createCapturingDataProvider();
    const executor = createActionExecutor({ dataProvider: dp });

    const fetchAction: ActionDefinition = {
      name: "cl_fetch",
      schema: "items",
      label: "Fetch item",
      exposure: "all",
      handler: async (ctx) => {
        return ctx.get("items", "item_1");
      },
    };
    executor.registry.register(fetchAction);

    const layer = createCommandLayer({ executor });
    const result = await layer.execute({
      command: "cl_fetch",
      input: {},
      channel: "http",
      locale: "ja",
    });

    expect(result.success).toBe(true);
    expect(dp.lastGetOptions).toBeDefined();
    expect(dp.lastGetOptions?.locale).toBe("ja");
  });

  test("locale is accessible in middleware via CommandContext", async () => {
    const dp = createCapturingDataProvider();
    const executor = createActionExecutor({ dataProvider: dp });

    const action: ActionDefinition = {
      name: "mw_locale_test",
      schema: "items",
      label: "Test",
      exposure: "all",
      handler: async (ctx) => ctx.get("items", "item_1"),
    };
    executor.registry.register(action);

    let capturedLocale: string | undefined;
    const layer = createCommandLayer({ executor });
    layer.use({
      name: "locale_capture",
      slot: "pre",
      handler: async (ctx, next) => {
        capturedLocale = ctx.locale;
        await next();
      },
    });

    await layer.execute({
      command: "mw_locale_test",
      input: {},
      channel: "http",
      locale: "fr-FR",
    });

    expect(capturedLocale).toBe("fr-FR");
  });
});
