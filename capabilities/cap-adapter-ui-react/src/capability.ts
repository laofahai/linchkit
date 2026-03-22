/**
 * Capability definition for cap-adapter-ui-react
 *
 * Registers the Vite dev server transport so `linch dev` starts the UI automatically.
 */

import type { CliCommandContext, TransportContext } from "@linchkit/core";
import { defineCapability } from "@linchkit/core";

export const capAdapterUiReact = defineCapability({
	name: "cap-adapter-ui-react",
	label: "React UI Shell",
	type: "adapter",
	category: "integration",
	version: "0.0.1",

	extensions: {
		transports: [
			{
				name: "ui",
				label: "React UI (Vite Dev Server)",
				factory: async (ctx: TransportContext) => {
					// Use Bun.spawn to start vite dev server as a child process
					// This is simpler and more reliable than programmatic Vite API
					const { resolve } = await import("node:path");
					const uiDir = resolve(import.meta.dir, "..");

					let proc: ReturnType<typeof Bun.spawn> | null = null;

					return {
						start: () => {
							// Read port from config or default to 3000
							const uiConfig = (ctx.config?.ui ?? {}) as { port?: number };
							const port = uiConfig.port ?? 3000;

							proc = Bun.spawn(["bunx", "vite", "--port", String(port)], {
								cwd: uiDir,
								stdout: "inherit",
								stderr: "inherit",
								env: { ...process.env },
							});

							console.log(
								`[cap-adapter-ui-react] UI: http://localhost:${port}`,
							);
						},
						stop: () => {
							if (proc) {
								proc.kill();
								proc = null;
							}
						},
					};
				},
				config: {
					port: {
						type: "number",
						default: 3000,
						description: "UI dev server port",
					},
				},
			},
		],
		commands: [
			{
				name: "dev",
				namespace: "ui",
				description: "Start React UI development server",
				isDefault: true,
				devOnly: true,
				args: {
					port: {
						type: "string",
						default: "3000",
						description: "UI dev server port",
					},
				},
				handler: async (_ctx: CliCommandContext) => {
					console.log(
						"[cap-adapter-ui-react] Starting UI dev server...",
					);
				},
			},
		],
	},

	systemPermissions: [],
});
