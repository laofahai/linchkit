/**
 * Dev entry point — run with `bun --watch src/dev.ts`
 *
 * Starts the LinchKit server with demo schemas, actions, and seed data.
 */

import { createActionExecutor } from "@linchkit/core";
import type { SchemaDefinition } from "@linchkit/core";
import { buildGraphQLSchema, generateCrudActions } from "./graphql/build-schema";
import { createServer } from "./server";
import { InMemoryStore } from "./data/in-memory-store";

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

// ── Initialize data store ────────────────────────────────

const store = new InMemoryStore();

// Seed demo data
store.seed("purchase_request", [
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

// ── Initialize action engine ─────────────────────────────

const executor = createActionExecutor({ dataProvider: store });

// Register CRUD actions for each schema
for (const schema of demoSchemas) {
	const crudActions = generateCrudActions(schema);
	for (const action of crudActions) {
		executor.registry.register(action);
	}
}

// ── Build schema and start server ────────────────────────

const graphqlSchema = buildGraphQLSchema(demoSchemas, { executor, store });
const port = 3001;
const server = createServer(graphqlSchema, { port });

server.listen(port);

console.log(`LinchKit server running at http://localhost:${port}`);
console.log(`GraphQL playground at http://localhost:${port}/graphql`);
console.log(`Health check at http://localhost:${port}/health`);
console.log(`Loaded ${demoSchemas.length} schema(s), ${store.count("purchase_request")} seed records`);
