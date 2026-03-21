/**
 * Dev entry point — run with `bun --watch src/dev.ts`
 *
 * Starts the LinchKit server with demo schemas, actions, and seed data.
 * Demonstrates end-to-end: Schema → Action → GraphQL → REST
 */

import type { ActionDefinition, SchemaDefinition } from "@linchkit/core";
import { buildGraphQLSchema, generateCrudActions } from "./graphql/build-schema";
import { createServer } from "./server";
import { createRuntimeContext } from "./runtime-context";

// ── Demo schema ──────────────────────────────────────────

const purchaseRequestSchema: SchemaDefinition = {
	name: "purchase_request",
	label: "Purchase Request",
	description: "A purchase request submitted for approval",
	fields: {
		title: { type: "string", required: true, label: "Title" },
		description: { type: "text", label: "Description" },
		amount: { type: "number", required: true, label: "Amount" },
		department: { type: "string", label: "Department" },
		requester: { type: "string", label: "Requester" },
		status: { type: "state", machine: "purchase_lifecycle" },
		priority: {
			type: "enum",
			options: [
				{ value: "low", label: "Low" },
				{ value: "medium", label: "Medium" },
				{ value: "high", label: "High" },
				{ value: "urgent", label: "Urgent" },
			],
			label: "Priority",
		},
		notes: { type: "text", label: "Notes" },
	},
};

const demoSchemas: SchemaDefinition[] = [purchaseRequestSchema];

// ── Custom actions (beyond CRUD) ────────────────────────

const submitAction: ActionDefinition = {
	name: "submit_purchase_request",
	schema: "purchase_request",
	label: "Submit Purchase Request",
	description: "Submit a draft purchase request for approval",
	input: {
		notes: { type: "text", label: "Submission Notes" },
	},
	policy: { mode: "sync", transaction: true },
	exposure: "all",
	handler: async (ctx) => {
		const id = ctx.input.id as string;
		const record = await ctx.get("purchase_request", id);
		if (record.status !== "draft") {
			throw new Error(`Cannot submit: current status is "${record.status}", expected "draft"`);
		}
		return ctx.update("purchase_request", id, {
			status: "pending",
			submitted_at: new Date().toISOString(),
		});
	},
};

const approveAction: ActionDefinition = {
	name: "approve_purchase_request",
	schema: "purchase_request",
	label: "Approve Purchase Request",
	description: "Approve a pending purchase request",
	permissions: { groups: ["admin", "manager"] },
	policy: { mode: "sync", transaction: true },
	exposure: "all",
	handler: async (ctx) => {
		const id = ctx.input.id as string;
		const record = await ctx.get("purchase_request", id);
		if (record.status !== "pending") {
			throw new Error(`Cannot approve: current status is "${record.status}", expected "pending"`);
		}
		return ctx.update("purchase_request", id, {
			status: "approved",
			approved_at: new Date().toISOString(),
			approved_by: ctx.actor.id,
		});
	},
};

// ── Build CRUD + custom actions ─────────────────────────

const allActions: ActionDefinition[] = [
	...demoSchemas.flatMap(generateCrudActions),
	submitAction,
	approveAction,
];

// ── Initialize runtime context ──────────────────────────

const runtime = createRuntimeContext({
	schemas: demoSchemas,
	actions: allActions,
});

// Seed demo data
runtime.store.seed("purchase_request", [
	{
		id: "pr_001",
		title: "Office Supplies Q2",
		description: "Quarterly office supply order for engineering team",
		amount: 1500,
		department: "Engineering",
		requester: "Alice Chen",
		status: "draft",
		priority: "medium",
		notes: "Includes monitors and keyboards",
	},
	{
		id: "pr_002",
		title: "Cloud Infrastructure Upgrade",
		description: "AWS reserved instances for production workloads",
		amount: 25000,
		department: "DevOps",
		requester: "Bob Wang",
		status: "pending",
		priority: "high",
		notes: "Annual commitment for cost savings",
	},
	{
		id: "pr_003",
		title: "Team Building Event",
		description: "Annual team outing and dinner",
		amount: 3000,
		department: "HR",
		requester: "Carol Li",
		status: "approved",
		priority: "low",
		notes: null,
	},
	{
		id: "pr_004",
		title: "Security Audit Tools",
		description: "License for penetration testing and vulnerability scanning",
		amount: 8500,
		department: "Security",
		requester: "Dave Zhang",
		status: "draft",
		priority: "urgent",
		notes: "Compliance requirement — deadline next month",
	},
]);

// ── Build schema and start server ────────────────────────

const customActions: ActionDefinition[] = [submitAction, approveAction];

const graphqlSchema = buildGraphQLSchema(demoSchemas, {
	executor: runtime.executor,
	store: runtime.store,
	actions: customActions,
	executionLogger: runtime.executionLogger,
});

const port = 3001;
const server = createServer(graphqlSchema, {
	port,
	executor: runtime.executor,
	executionLogger: runtime.executionLogger,
	schemaRegistry: runtime.schemaRegistry,
});

server.listen(port);

console.log(`\nLinchKit Dev Server`);
console.log(`───────────────────────────────────`);
console.log(`  HTTP:       http://localhost:${port}`);
console.log(`  GraphQL:    http://localhost:${port}/graphql`);
console.log(`  Health:     http://localhost:${port}/health`);
console.log(`  REST API:   http://localhost:${port}/api/actions/:name`);
console.log(`  Exec Logs:  http://localhost:${port}/api/executions`);
console.log(`───────────────────────────────────`);
console.log(`  Schemas:    ${demoSchemas.length} (${demoSchemas.map(s => s.name).join(", ")})`);
console.log(`  Actions:    ${allActions.length} (${allActions.map(a => a.name).join(", ")})`);
console.log(`  Records:    ${runtime.store.count("purchase_request")} seed records`);
console.log(`  Logger:     InMemoryExecutionLogger enabled`);
console.log(`───────────────────────────────────\n`);
