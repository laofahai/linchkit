/**
 * Spec 52 §2.6 — POST /api/ai/resolve-intent
 *
 * Wires the canonical `resolveIntent()` resolver from `@linchkit/cap-ai-provider`
 * into a real HTTP endpoint. The route is a thin consumer of the resolver:
 *
 *  - Validates `{ prompt, scope }` with Zod.
 *  - Builds a permission-scoped Ontology view so the AI only sees actions the
 *    calling actor can actually execute (Spec 52 §1.1 — "AI sees only what the
 *    current user can see").
 *  - Returns `{ proposal: ActionProposal | null }` (200 either way — a null
 *    proposal is a normal "no usable match" outcome, not an error).
 *  - Emits one AI audit entry per call (success, no-match, or failure) using
 *    the canonical `logIntentResolution()` helper so the full intent-resolution
 *    traffic is auditable per Spec 52 §8.1.4.
 *
 * Hard rules (Spec 52 §1.1):
 *  - This route NEVER executes the proposed action. The user confirms via
 *    the existing `POST /api/actions/:name` endpoint after reviewing the card.
 *  - When the resolver/AI is unavailable the endpoint degrades gracefully —
 *    503 with a structured envelope so the UI can show "AI unavailable" UX.
 */

import { type ActionProposal, resolveIntent } from "@linchkit/cap-ai-provider";
import type {
  ActionDefinition,
  Actor,
  AIService,
  FieldDefinition,
  OntologyRegistry,
  PermissionRegistry,
} from "@linchkit/core";
import type { AIAuditLogger } from "@linchkit/core/server";
import { checkActionPermission } from "@linchkit/core/server";
import type { Elysia } from "elysia";
import { z } from "zod";
import type { ServerOptions } from "../server";
import { resolveActor, serviceUnavailable } from "./shared";

// ── Request shape (Zod) ──────────────────────────────────────

/**
 * Wire-format request body. Matches the resolver's `ResolveIntentInput`
 * minus the server-managed `tenant` / `userId` fields, which are derived
 * from the authenticated request context (never client-supplied).
 */
const resolveIntentRequestSchema = z
  .object({
    prompt: z.string().min(1, "prompt must be a non-empty string"),
    scope: z
      .object({
        entityFilter: z.array(z.string()).optional(),
        actionFilter: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

// ── Permission-scoped Ontology wrapper ──────────────────────

/**
 * Minimal `OntologyRegistryLike` exposed to `resolveIntent()`. We define this
 * locally rather than re-importing the resolver's type to keep the dependency
 * surface flat (the resolver intentionally consumes a structural type).
 */
interface OntologyRegistryLike {
  listEntities(): string[];
  actionsFor(entityName: string): ActionDefinition[];
}

/**
 * Build an `OntologyRegistryLike` view that only exposes actions the calling
 * actor can execute. Implements Spec 52 §1.1 hard rule: "AI sees only what the
 * current user can see." If `permissionRegistry` is missing (typical for dev
 * runs without cap-permission wired in), we pass actions through unchanged —
 * matching the rest of the server's permissive default for unauthenticated
 * dev environments.
 *
 * Permission convention follows `permission-middleware.ts`: when no explicit
 * capability resolver is provided, the action's `entity` is used as the
 * capability name in the registry lookup. Same convention used here.
 */
function buildPermissionScopedOntology(opts: {
  base: OntologyRegistry;
  permissionRegistry?: PermissionRegistry;
  actor: Actor;
}): OntologyRegistryLike {
  const { base, permissionRegistry, actor } = opts;

  if (!permissionRegistry) {
    // Pass-through wrapper. We still narrow to OntologyRegistryLike so that
    // callers can't accidentally rely on the wider OntologyRegistry surface.
    return {
      listEntities: () => base.listEntities(),
      actionsFor: (entityName: string) => base.actionsFor(entityName),
    };
  }

  return {
    listEntities: () => base.listEntities(),
    actionsFor: (entityName: string) => {
      const all = base.actionsFor(entityName);
      const allowed: ActionDefinition[] = [];
      for (const action of all) {
        const result = checkActionPermission(permissionRegistry, actor, action.entity, action.name);
        if (result.allowed) {
          allowed.push(action);
        }
      }
      return allowed;
    },
  };
}

// ── Audit emission helper ───────────────────────────────────

/**
 * Emit one AI audit entry per resolve-intent call (Spec 52 §8.1.4).
 *
 * Thin wrapper around the canonical `AIAuditLogger.logIntentResolution()`
 * helper — kept as a function in this module so future call sites (e.g. an
 * MCP transport) don't need to know the actor-id derivation.
 */
function emitIntentResolutionAudit(opts: {
  logger: AIAuditLogger;
  actor: Actor;
  tenantId: string | undefined;
  prompt: string;
  durationMs: number;
  matched: boolean;
  action: string | null;
  confidence: number | null;
  catalogSize: number;
  scoped: boolean;
  serviceUnavailable: boolean;
}): void {
  opts.logger.logIntentResolution({
    actorId: opts.actor.id,
    tenantId: opts.tenantId,
    prompt: opts.prompt,
    matched: opts.matched,
    action: opts.action,
    confidence: opts.confidence,
    durationMs: opts.durationMs,
    catalogSize: opts.catalogSize,
    scoped: opts.scoped,
    serviceUnavailable: opts.serviceUnavailable,
  });
}

// ── Route ───────────────────────────────────────────────────

/**
 * Mount `POST /api/ai/resolve-intent` onto the given Elysia app.
 *
 * Behavior summary:
 *   400 — request body fails Zod validation (missing/empty prompt, etc).
 *   503 — AI service is not configured on the server (`aiService.configured === false`).
 *   200 — every other case. `proposal` is `null` when the resolver returned null.
 */
export function mountResolveIntentRoute(app: Elysia, options: ServerOptions): void {
  app.post("/api/ai/resolve-intent", async ({ body, request, set }) => {
    const parsed = resolveIntentRequestSchema.safeParse(body);
    if (!parsed.success) {
      set.status = 400;
      const issue = parsed.error.issues[0];
      return {
        success: false as const,
        error: {
          code: "VALIDATION.FAILED",
          message: issue?.message ?? "Invalid request body for /api/ai/resolve-intent",
        },
      };
    }

    const aiService: AIService | undefined = options.aiService;
    const ontologyRegistry = options.ontologyRegistry;
    const auditLogger = options.aiAuditLogger;

    // Resolve actor + tenant from the trusted request context. NEVER read
    // these from the body (Spec 52 §1.1 — AI operates as the user).
    const actor = await resolveActor(request, options.resolveRequestActor);
    const resolveTenant = options.resolveRequestTenantId;
    const tenantId = resolveTenant ? await resolveTenant(request, actor) : undefined;

    // Helper: audit the unavailable case + return 503. The audit entry is
    // emitted whether or not the AI service was even reachable so operators
    // can see the rate of attempts hitting an un-configured deployment.
    const handleUnavailable = (message: string) => {
      auditLogger &&
        emitIntentResolutionAudit({
          logger: auditLogger,
          actor,
          tenantId,
          prompt: parsed.data.prompt,
          durationMs: 0,
          matched: false,
          action: null,
          confidence: null,
          catalogSize: 0,
          scoped: false,
          serviceUnavailable: true,
        });
      return serviceUnavailable(set, message);
    };

    // Spec 52 §1.1 graceful degradation — if AI isn't configured, surface 503
    // with a structured error so the caller can show "AI unavailable" UX.
    if (!aiService?.configured) {
      return handleUnavailable(
        "AI service is not configured. Configure an AI provider in linchkit.config.ts to enable intent resolution.",
      );
    }

    // The resolver needs an Ontology view. If the server wasn't constructed
    // with one, treat that as misconfiguration → 503 (rare in dev runs;
    // CLI dev wiring always provides it).
    if (!ontologyRegistry) {
      return handleUnavailable(
        "Ontology registry is not available — intent resolution requires the unified Ontology layer.",
      );
    }

    const scopedOntology = buildPermissionScopedOntology({
      base: ontologyRegistry,
      permissionRegistry: options.permissionRegistry,
      actor,
    });

    // Compute the actor-visible catalog size BEFORE the resolver runs so the
    // audit entry has it even when the resolver returns null. This mirrors
    // the resolver's internal de-duplication (one entry per unique action
    // name across all entities).
    const catalogSize = computeUniqueCatalogSize(scopedOntology);

    const startedAt = Date.now();
    let proposal: Awaited<ReturnType<typeof resolveIntent>> = null;
    try {
      proposal = await resolveIntent(
        {
          prompt: parsed.data.prompt,
          scope: parsed.data.scope,
          tenant: tenantId,
          userId: actor.id,
        },
        {
          ai: aiService,
          ontology: scopedOntology,
        },
      );
    } catch (err) {
      // The resolver itself swallows AI errors and returns null, so reaching
      // this branch means a programmer error / unexpected throw. Surface a
      // 500 but still emit an audit entry so the failure isn't invisible.
      const durationMs = Date.now() - startedAt;
      auditLogger &&
        emitIntentResolutionAudit({
          logger: auditLogger,
          actor,
          tenantId,
          prompt: parsed.data.prompt,
          durationMs,
          matched: false,
          action: null,
          confidence: null,
          catalogSize,
          scoped: Boolean(options.permissionRegistry),
          serviceUnavailable: false,
        });
      const message = err instanceof Error ? err.message : "Intent resolution failed";
      set.status = 500;
      return {
        success: false as const,
        error: { code: "AI.RESOLVE_INTENT.FAILED", message },
      };
    }

    const durationMs = Date.now() - startedAt;

    if (auditLogger) {
      emitIntentResolutionAudit({
        logger: auditLogger,
        actor,
        tenantId,
        prompt: parsed.data.prompt,
        durationMs,
        matched: proposal !== null,
        action: proposal?.action ?? null,
        confidence: proposal?.confidence ?? null,
        catalogSize,
        scoped: Boolean(options.permissionRegistry),
        serviceUnavailable: false,
      });
    }

    // Enrich the proposal with the action's display metadata so the UI can
    // render an Action Proposal Card without a second round-trip. The
    // resolver itself returns the bare ActionProposal; callers (UI / MCP)
    // need entity name, action label/description, and the input schema for
    // form rendering. None of these are user-controlled — they all come
    // from the (already-permission-scoped) ontology.
    const view = enrichProposal(proposal, scopedOntology);
    return { proposal: view };
  });
}

// ── Response enrichment ─────────────────────────────────────

/** Wire-format proposal: bare resolver output plus action display metadata. */
export interface ActionProposalView extends ActionProposal {
  /** Entity name the matched action operates on. */
  schema: string;
  /** Human-readable action label (from `defineAction({ label })`). */
  actionLabel: string;
  /** Optional human-readable action description. */
  actionDescription?: string;
  /** Input parameter descriptors suitable for rendering a confirmation form. */
  inputSchema: Record<string, IntentFieldSchema>;
}

/** Wire-format input field schema — minimal projection of `FieldDefinition`. */
export interface IntentFieldSchema {
  type: string;
  label?: string;
  required: boolean;
  options?: Array<{ value: string; label?: string }>;
  description?: string;
}

function enrichProposal(
  proposal: ActionProposal | null,
  ontology: OntologyRegistryLike,
): ActionProposalView | null {
  if (!proposal) return null;

  // Find the matched action in the (scoped) ontology so we never disclose
  // metadata for an action the user can't see.
  for (const entityName of ontology.listEntities()) {
    for (const action of ontology.actionsFor(entityName)) {
      if (action.name === proposal.action) {
        return {
          ...proposal,
          schema: action.entity,
          actionLabel: action.label ?? action.name,
          actionDescription: action.description,
          inputSchema: buildInputSchema(action),
        };
      }
    }
  }

  // Spec 52 §1.1 hard rule: "AI sees only what the current user can see."
  // The resolver's catalog-allowlist should already drop proposals outside
  // the scoped catalog, but we enforce it once more at the exit point so a
  // hallucinated action name (whether from prompt injection or a stale
  // training corpus) cannot be confirmed back to the caller. Returning null
  // is the same as "no usable match" from the resolver's own perspective.
  return null;
}

function buildInputSchema(action: ActionDefinition): Record<string, IntentFieldSchema> {
  const schema: Record<string, IntentFieldSchema> = {};
  if (!action.input) return schema;
  for (const [name, raw] of Object.entries(action.input)) {
    const field = raw as FieldDefinition;
    schema[name] = {
      type: field.type,
      label: field.label,
      required: field.required === true,
      description: field.description,
      options: extractFieldOptions(field),
    };
  }
  return schema;
}

function extractFieldOptions(
  field: FieldDefinition,
): Array<{ value: string; label?: string }> | undefined {
  // EnumField uses `options: [{ value, label? }, ...]`. Other field types
  // do not carry option lists at this level. Read structurally to avoid
  // depending on the discriminated-union type narrowing of FieldDefinition.
  const fieldRecord = field as unknown as Record<string, unknown>;
  const options = fieldRecord.options;
  if (!Array.isArray(options)) return undefined;
  const out: Array<{ value: string; label?: string }> = [];
  for (const opt of options) {
    if (opt && typeof opt === "object" && "value" in opt) {
      const o = opt as { value: unknown; label?: unknown };
      // Coerce to string at the wire boundary — IntentFieldSchema.options
      // is `string` for UI form rendering, but EnumField definitions
      // sometimes use numeric values (status codes, version numbers).
      // Dropping them silently would leave the user without those choices.
      // NaN is excluded — `String(NaN) === "NaN"` would smuggle a useless
      // option into the UI.
      const isStringValue = typeof o.value === "string";
      const isFiniteNumberValue = typeof o.value === "number" && Number.isFinite(o.value);
      if (isStringValue || isFiniteNumberValue) {
        out.push({
          value: String(o.value),
          label: typeof o.label === "string" ? o.label : undefined,
        });
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Compute the de-duplicated number of actions visible through the given
 * Ontology view. Matches the resolver's own catalog construction so the
 * audit `catalogSize` field is meaningful for permission-scoping checks.
 */
function computeUniqueCatalogSize(ontology: OntologyRegistryLike): number {
  const seen = new Set<string>();
  for (const entityName of ontology.listEntities()) {
    for (const action of ontology.actionsFor(entityName)) {
      seen.add(action.name);
    }
  }
  return seen.size;
}
