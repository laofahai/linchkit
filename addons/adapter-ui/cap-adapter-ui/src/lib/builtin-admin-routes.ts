/**
 * Built-in admin route registrations.
 *
 * Import this module to register default admin pages.
 */

import { registerAdminRoute } from "./route-registry";

registerAdminRoute({
	id: "executions",
	capability: "__builtin__",
	path: "/admin/executions",
	label: "executionLog.title",
	icon: "ScrollText",
	order: 100,
	component: () =>
		import("../pages/execution-logs").then((m) => ({ default: m.ExecutionLogsPage })),
});
