import { afterEach, describe, expect, it } from "bun:test";
import {
	_clearAdminRoutes,
	getAdminRoutes,
	registerAdminRoute,
} from "../src/lib/route-registry";

// ── Helpers ─────────────────────────────────────────────

function makeRoute(overrides: Record<string, unknown> = {}) {
	return {
		id: "test-route",
		capability: "__builtin__",
		path: "/admin/test",
		label: "test.title",
		component: () => Promise.resolve({ default: () => null }),
		...overrides,
	};
}

// ── Tests ───────────────────────────────────────────────

describe("Admin Route Registry", () => {
	afterEach(() => {
		_clearAdminRoutes();
	});

	it("registerAdminRoute adds a route", () => {
		registerAdminRoute(makeRoute());
		expect(getAdminRoutes()).toHaveLength(1);
		expect(getAdminRoutes()[0]?.id).toBe("test-route");
	});

	it("getAdminRoutes returns sorted by order", () => {
		registerAdminRoute(makeRoute({ id: "c", order: 300 }));
		registerAdminRoute(makeRoute({ id: "a", order: 10 }));
		registerAdminRoute(makeRoute({ id: "b", order: 50 }));

		const routes = getAdminRoutes();
		expect(routes.map((r) => r.id)).toEqual(["a", "b", "c"]);
	});

	it("throws on duplicate ID", () => {
		registerAdminRoute(makeRoute({ id: "dup" }));
		expect(() => registerAdminRoute(makeRoute({ id: "dup" }))).toThrow(
			'Admin route "dup" is already registered',
		);
	});

	it("getAdminRoutes returns a copy, not a reference", () => {
		registerAdminRoute(makeRoute());
		const a = getAdminRoutes();
		const b = getAdminRoutes();
		expect(a).not.toBe(b);
		expect(a).toEqual(b);
	});

	it("default order is 100", () => {
		registerAdminRoute(makeRoute({ id: "low", order: 50 }));
		registerAdminRoute(makeRoute({ id: "default" })); // no order → 100
		registerAdminRoute(makeRoute({ id: "high", order: 200 }));

		const routes = getAdminRoutes();
		expect(routes.map((r) => r.id)).toEqual(["low", "default", "high"]);
	});

	it("preserves all registration fields", () => {
		const route = makeRoute({
			id: "full",
			capability: "cap-mcp",
			path: "/admin/mcp",
			label: "mcp.title",
			icon: "Terminal",
			order: 42,
		});
		registerAdminRoute(route);

		const [result] = getAdminRoutes();
		expect(result?.id).toBe("full");
		expect(result?.capability).toBe("cap-mcp");
		expect(result?.path).toBe("/admin/mcp");
		expect(result?.label).toBe("mcp.title");
		expect(result?.icon).toBe("Terminal");
		expect(result?.order).toBe(42);
	});
});
