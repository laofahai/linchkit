/**
 * linch events — Inspect and replay persisted events
 *
 * Subcommands:
 *   list         — Paginated browse of `_linchkit.events` rows
 *   inspect      — Full event detail (payload + handler history)
 *   replay       — Re-dispatch a single event to registered handlers
 *   replay-batch — Re-dispatch events matching a filter (resolved via list)
 *
 * Read-only subcommands (list, inspect) need only a database connection.
 * Mutating subcommands (replay, replay-batch) require the full event-handler
 * registry to be populated from `linchkit.config.ts`, mirroring the dev
 * runtime so handlers behave identically to a normal delivery (Spec 66 §4).
 */

import type {
  BatchReplayResult,
  EventDetail,
  EventHandlerRegistry,
  EventListOptions,
  EventReplayService,
  EventSummary,
  HandlerExecution,
  ReplayResult,
} from "@linchkit/core/server";
import { defineCommand } from "citty";
import {
  type Column,
  confirmAction,
  fmtTimestamp,
  parseCsvArg,
  parseDateArg,
  parseIntArg,
  printTable,
  truncate,
} from "../utils/cli-format";
import { defaultServiceFactory, type ServiceFactory, type ServiceHandle } from "./events-bootstrap";

// ── Service factory (overridable for tests) ─────────────────

let serviceFactory: ServiceFactory = defaultServiceFactory;

/** Override the service factory (tests only). */
export function setServiceFactory(factory: ServiceFactory | null): void {
  serviceFactory = factory ?? defaultServiceFactory;
}

export type { ServiceFactory } from "./events-bootstrap";

const MAX_DESC_WIDTH = 40;

// ── Pure command handlers (testable without citty) ──────────

export interface ListArgs {
  entity?: string;
  /** recordId is not a column in `_linchkit.events`; it is applied as a payload filter. */
  record?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
  json?: boolean;
}

export interface InspectArgs {
  eventId: string;
  json?: boolean;
}

export interface ReplayArgs {
  eventId: string;
  dryRun?: boolean;
  handlers?: string;
  yes?: boolean;
  json?: boolean;
}

export interface ReplayBatchArgs {
  entity?: string;
  since?: string;
  until?: string;
  dryRun?: boolean;
  limit?: number;
  yes?: boolean;
  json?: boolean;
}

export async function runList(svc: EventReplayService, args: ListArgs): Promise<void> {
  const limit = parseIntArg("--limit", args.limit, 50);
  const offset = parseIntArg("--offset", args.offset, 0);
  const opts: EventListOptions = {
    entity: args.entity,
    since: parseDateArg("--since", args.since),
    until: parseDateArg("--until", args.until),
    limit,
    offset,
  };
  const { items, total } = await svc.list(opts);

  // recordId is not a column on `_linchkit.events` — it lives inside the
  // JSONB payload. When --record is given, fetch each candidate row's full
  // detail (capped by --limit) and filter by payload.recordId. This costs
  // up to `limit` extra queries; the upper bound (100) keeps it predictable.
  const enrichedRows = args.record ? await enrichWithRecordIds(svc, items) : items;
  const filtered = args.record
    ? enrichedRows.filter((row) => extractRecordId(row) === args.record)
    : enrichedRows;

  if (args.json) {
    console.log(JSON.stringify({ items: filtered, total }, null, 2));
    return;
  }

  if (filtered.length === 0) {
    console.log("[linch] No events found.");
    return;
  }

  const columns: Column<EventSummary>[] = [
    { header: "Timestamp", width: 24, get: (r) => fmtTimestamp(r.createdAt) },
    { header: "Entity", width: 20, get: (r) => r.sourceAction ?? "" },
    { header: "RecordId", width: 36, get: (r) => extractRecordId(r) ?? "" },
    { header: "EventType", width: 30, get: (r) => r.eventType },
    { header: "Id", width: 36, get: (r) => r.id },
  ];
  printTable(filtered, columns);
  console.log(`\nShowing ${filtered.length} of ${total} event(s).`);
}

/**
 * EventSummary intentionally omits payload (Spec 66 §3.1 — list is a
 * lightweight projection). Pull recordId from a `recordId` field added by
 * enrichment (or by a test double that pre-projects it); otherwise return
 * undefined.
 */
function extractRecordId(row: EventSummary): string | undefined {
  const maybe = (row as unknown as { recordId?: unknown }).recordId;
  return typeof maybe === "string" ? maybe : undefined;
}

/**
 * Enrich list rows with the payload's `recordId` so client-side --record
 * filtering can match. N+1 by design — capped at the caller-supplied limit
 * (default 50, max 100) and only invoked when --record is set.
 */
async function enrichWithRecordIds(
  svc: EventReplayService,
  rows: EventSummary[],
): Promise<(EventSummary & { recordId?: string })[]> {
  return Promise.all(
    rows.map(async (row) => {
      const detail = await svc.get(row.id);
      const recordId = detail?.payload?.recordId;
      return {
        ...row,
        recordId: typeof recordId === "string" ? recordId : undefined,
      };
    }),
  );
}

export async function runInspect(svc: EventReplayService, args: InspectArgs): Promise<void> {
  const detail = await svc.get(args.eventId);
  if (!detail) {
    console.error(`[linch] Event not found: ${args.eventId}`);
    process.exitCode = 1;
    return;
  }

  if (args.json) {
    console.log(JSON.stringify(detail, null, 2));
    return;
  }

  printEventDetail(detail);
}

function printEventDetail(detail: EventDetail): void {
  console.log(`Event ${detail.id}`);
  console.log(`  Type:        ${detail.eventType}`);
  console.log(`  Status:      ${detail.status}`);
  console.log(`  Tenant:      ${detail.tenantId ?? "(none)"}`);
  console.log(`  Source:      ${detail.sourceAction ?? "(none)"}`);
  console.log(`  Execution:   ${detail.sourceExecutionId ?? "(none)"}`);
  console.log(`  Created:     ${fmtTimestamp(detail.createdAt)}`);
  console.log(`  Processed:   ${fmtTimestamp(detail.processedAt)}`);
  console.log(`  RetryCount:  ${detail.retryCount}`);
  if (detail.errorMessage) {
    console.log(`  Error:       ${truncate(detail.errorMessage, MAX_DESC_WIDTH * 4)}`);
  }
  console.log("");
  console.log("Payload:");
  console.log(JSON.stringify(detail.payload, null, 2));
  if (detail.meta) {
    console.log("");
    console.log("Meta:");
    console.log(JSON.stringify(detail.meta, null, 2));
  }
  console.log("");
  console.log("Handler History:");
  const columns: Column<HandlerExecution>[] = [
    { header: "Handler", width: 30, get: (h) => h.handler },
    { header: "Status", width: 12, get: (h) => h.status },
    { header: "Retries", width: 8, get: (h) => String(h.retryCount) },
    { header: "Attempted", width: 24, get: (h) => fmtTimestamp(h.attemptedAt) },
    { header: "Completed", width: 24, get: (h) => fmtTimestamp(h.completedAt) },
  ];
  printTable(detail.history, columns);
}

export async function runReplay(
  svc: EventReplayService,
  args: ReplayArgs,
  registry?: EventHandlerRegistry,
): Promise<void> {
  const handlers = parseCsvArg(args.handlers);

  // Resolve event first so both dry-run and live paths produce the same
  // "missing event" error (Spec 66 §4.2 — replay never silently succeeds).
  const detail = await svc.get(args.eventId);
  if (!detail) {
    console.error(`[linch] Event not found: ${args.eventId}`);
    process.exitCode = 1;
    return;
  }

  // Resolve which handlers would actually fire — used for the confirm
  // prompt and dry-run report so callers see real handler names, not "*".
  const wouldFire = resolveHandlerNames(registry, detail.eventType, handlers);

  if (!args.dryRun) {
    const ok = await confirmAction(
      `Replay event ${args.eventId} to ${describeHandlerList(wouldFire)}?`,
      args.yes ?? false,
    );
    if (!ok) {
      console.log("[linch] Replay cancelled.");
      return;
    }
  }

  if (args.dryRun) {
    const report = {
      dryRun: true,
      eventId: detail.id,
      eventType: detail.eventType,
      handlers: wouldFire,
    };
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`[dry-run] Would replay event ${detail.id} (${detail.eventType}).`);
    console.log(`[dry-run] Handlers: ${wouldFire.length > 0 ? wouldFire.join(", ") : "(none)"}.`);
    return;
  }

  // Spec 66 §4.2 — when `--handlers` lists more than one name, dispatch
  // each one separately so we can attribute per-handler outcomes. The
  // underlying service accepts only a single `onlyHandler` per call.
  const targets = handlers ?? [undefined];
  const aggregate: ReplayResult = { delivered: 0, errors: [] };
  for (const onlyHandler of targets) {
    const result = await svc.replay(args.eventId, { onlyHandler });
    aggregate.delivered += result.delivered;
    aggregate.errors.push(...result.errors);
  }

  if (args.json) {
    console.log(JSON.stringify(aggregate, null, 2));
    return;
  }
  printReplayReport(args.eventId, aggregate);
  if (aggregate.errors.length > 0) process.exitCode = 2;
}

/**
 * Resolve the list of handler names that a replay would dispatch to.
 *
 * - When `handlers` is supplied (`--handlers a,b`), use that as the authoritative set.
 * - Otherwise look up registered handlers for the event type via the registry.
 * - When the registry is not available (e.g. the CLI was started without
 *   capability bootstrapping), fall back to a wildcard placeholder so the
 *   user still sees something meaningful — but never silently report `*`
 *   when a real list is reachable (codex finding).
 */
function resolveHandlerNames(
  registry: EventHandlerRegistry | undefined,
  eventType: string,
  selected: string[] | undefined,
): string[] {
  if (selected && selected.length > 0) return selected;
  if (!registry) return ["*"];
  return registry.getByEvent(eventType).map((h) => h.name);
}

function describeHandlerList(names: string[]): string {
  if (names.length === 0) return "no registered handlers";
  if (names.length === 1 && names[0] === "*") return "all registered handlers";
  return `handlers [${names.join(", ")}]`;
}

function printReplayReport(eventId: string, report: ReplayResult): void {
  console.log(`Replay report for ${eventId}`);
  console.log(`  Delivered: ${report.delivered}`);
  console.log(`  Errors:    ${report.errors.length}`);
  if (report.errors.length === 0) return;
  console.log("");
  console.log("Errors:");
  const columns: Column<{ handler: string; message: string }>[] = [
    { header: "Handler", width: 30, get: (e) => e.handler },
    { header: "Message", width: 60, get: (e) => truncate(e.message, 60) },
  ];
  printTable(report.errors, columns);
}

export async function runReplayBatch(
  svc: EventReplayService,
  args: ReplayBatchArgs,
): Promise<void> {
  const limit = parseIntArg("--limit", args.limit, 50);
  const since = parseDateArg("--since", args.since);
  const until = parseDateArg("--until", args.until);

  // Spec 66 §3.2 — list a window, then dispatch by id. Caps at `limit` so
  // an accidental `linch events replay-batch` cannot fan out to the entire
  // event table in a single shot.
  const { items, total } = await svc.list({
    entity: args.entity,
    since,
    until,
    limit,
  });

  if (items.length === 0) {
    if (args.json) {
      console.log(JSON.stringify({ results: [], totalDelivered: 0, totalErrors: 0 }, null, 2));
      return;
    }
    console.log("[linch] No events match the filter.");
    return;
  }

  if (!args.dryRun) {
    const ok = await confirmAction(
      `Replay ${items.length} event(s) (of ${total} match(es))?`,
      args.yes ?? false,
    );
    if (!ok) {
      console.log("[linch] Batch replay cancelled.");
      return;
    }
  }

  const ids = items.map((row) => row.id);

  if (args.dryRun) {
    const report = {
      dryRun: true,
      matched: total,
      planned: ids.length,
      ids,
    };
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`[dry-run] Would replay ${ids.length} event(s) (of ${total} matched).`);
    for (const id of ids) console.log(`  ${id}`);
    return;
  }

  const result = await svc.replayBatch(ids);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printBatchReport(result);
  if (result.totalErrors > 0) process.exitCode = 2;
}

function printBatchReport(result: BatchReplayResult): void {
  console.log("Batch replay report");
  console.log(`  Events:    ${result.results.length}`);
  console.log(`  Delivered: ${result.totalDelivered}`);
  console.log(`  Errors:    ${result.totalErrors}`);
  if (result.results.length === 0) return;
  console.log("");
  const columns: Column<BatchReplayResult["results"][number]>[] = [
    { header: "EventId", width: 36, get: (r) => r.id },
    { header: "Replayed", width: 9, get: (r) => (r.replayed ? "yes" : "no") },
    { header: "Delivered", width: 9, get: (r) => String(r.delivered) },
    { header: "Errors", width: 6, get: (r) => String(r.errors.length) },
  ];
  printTable(result.results, columns);
}

// ── Citty wrappers ──────────────────────────────────────────

async function withService(
  needsRegistry: boolean,
  fn: (handle: ServiceHandle) => Promise<void>,
): Promise<void> {
  let handle: ServiceHandle | undefined;
  try {
    handle = await serviceFactory({ needsRegistry });
    await fn(handle);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[linch] ${msg}`);
    process.exitCode = 1;
  } finally {
    if (handle) {
      try {
        await handle.cleanup();
      } catch {
        // Cleanup errors are non-fatal — the CLI process is exiting either way.
      }
    }
  }
}

const eventsListCommand = defineCommand({
  meta: { name: "list", description: "List persisted events" },
  args: {
    entity: { type: "string", description: "Filter by source action / entity" },
    record: { type: "string", description: "Filter by recordId (payload-side)" },
    since: { type: "string", description: "Lower bound on createdAt (ISO 8601)" },
    until: { type: "string", description: "Upper bound on createdAt (ISO 8601)" },
    limit: { type: "string", description: "Max entries (default 50, max 100)", default: "50" },
    offset: { type: "string", description: "Offset for pagination", default: "0" },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  async run({ args }) {
    await withService(false, (handle) =>
      runList(handle.service, {
        entity: args.entity as string | undefined,
        record: args.record as string | undefined,
        since: args.since as string | undefined,
        until: args.until as string | undefined,
        limit: parseIntArg("--limit", args.limit, 50),
        offset: parseIntArg("--offset", args.offset, 0),
        json: args.json as boolean,
      }),
    );
  },
});

const eventsInspectCommand = defineCommand({
  meta: { name: "inspect", description: "Print full event detail + handler history" },
  args: {
    eventId: { type: "positional", description: "Event id (uuid)", required: true },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  async run({ args }) {
    await withService(false, (handle) =>
      runInspect(handle.service, {
        eventId: args.eventId as string,
        json: args.json as boolean,
      }),
    );
  },
});

const eventsReplayCommand = defineCommand({
  meta: { name: "replay", description: "Re-dispatch a single event" },
  args: {
    eventId: { type: "positional", description: "Event id (uuid)", required: true },
    "dry-run": { type: "boolean", description: "Resolve handlers but do not invoke them" },
    handlers: { type: "string", description: "Comma-separated handler names to limit dispatch" },
    yes: { type: "boolean", description: "Skip confirmation prompt", default: false },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  async run({ args }) {
    const dryRun = (args["dry-run"] as boolean | undefined) ?? false;
    // Always bootstrap the registry — dry-run resolves the handler list
    // via the registry, and live replay's confirm prompt names handlers
    // explicitly. Loading is cheap when capabilities are already imported.
    await withService(true, (handle) =>
      runReplay(
        handle.service,
        {
          eventId: args.eventId as string,
          dryRun,
          handlers: args.handlers as string | undefined,
          yes: args.yes as boolean,
          json: args.json as boolean,
        },
        handle.registry,
      ),
    );
  },
});

const eventsReplayBatchCommand = defineCommand({
  meta: { name: "replay-batch", description: "Re-dispatch a window of matching events" },
  args: {
    entity: { type: "string", description: "Filter by source action / entity" },
    since: { type: "string", description: "Lower bound on createdAt (ISO 8601)" },
    until: { type: "string", description: "Upper bound on createdAt (ISO 8601)" },
    limit: {
      type: "string",
      description: "Cap matched events (default 50, max 100)",
      default: "50",
    },
    "dry-run": { type: "boolean", description: "Resolve targets but do not dispatch" },
    yes: { type: "boolean", description: "Skip confirmation prompt", default: false },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  async run({ args }) {
    const dryRun = (args["dry-run"] as boolean | undefined) ?? false;
    await withService(!dryRun, (handle) =>
      runReplayBatch(handle.service, {
        entity: args.entity as string | undefined,
        since: args.since as string | undefined,
        until: args.until as string | undefined,
        limit: parseIntArg("--limit", args.limit, 50),
        dryRun,
        yes: args.yes as boolean,
        json: args.json as boolean,
      }),
    );
  },
});

export const eventsCommand = defineCommand({
  meta: {
    name: "events",
    description: "Inspect and replay persisted events",
  },
  subCommands: {
    list: eventsListCommand,
    inspect: eventsInspectCommand,
    replay: eventsReplayCommand,
    "replay-batch": eventsReplayBatchCommand,
  },
});
