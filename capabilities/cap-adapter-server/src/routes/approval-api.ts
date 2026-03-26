/**
 * Approval REST endpoints.
 *
 * - GET /api/approvals — list pending approvals
 * - GET /api/approvals/count — count pending approvals
 * - GET /api/approvals/:id — get single approval
 * - POST /api/approvals/:id/approve — approve a request
 * - POST /api/approvals/:id/reject — reject a request
 */

import type { ApprovalStatus } from "@linchkit/core";
import type { Elysia } from "elysia";
import type { ServerOptions } from "../server";
import { resolveActor } from "./shared";

export function mountApprovalRoutes(
  app: Elysia,
  options: ServerOptions,
): void {
  const approvalEngine = options.approvalEngine;
  const resolveRequestActor = options.resolveRequestActor;
  const resolveRequestTenantId = options.resolveRequestTenantId;

  app
    .get("/api/approvals", async ({ request, query, set }) => {
      if (!approvalEngine) {
        set.status = 501;
        return { success: false, error: { message: "Approval engine not configured." } };
      }
      const actor = await resolveActor(request, resolveRequestActor);

      const statusFilter = query.status as ApprovalStatus | undefined;
      const requests = await approvalEngine.store.query({
        status: statusFilter ?? "pending",
        tenantId: resolveRequestTenantId
          ? (await resolveRequestTenantId(request, actor)) ?? undefined
          : undefined,
      });
      return { success: true, data: { items: requests, total: requests.length } };
    })
    .get("/api/approvals/count", async ({ request, set }) => {
      if (!approvalEngine) {
        return { success: true, data: { count: 0 } };
      }
      const actor = await resolveActor(request, resolveRequestActor);
      const requests = await approvalEngine.store.query({
        status: "pending",
        tenantId: resolveRequestTenantId
          ? (await resolveRequestTenantId(request, actor)) ?? undefined
          : undefined,
      });
      return { success: true, data: { count: requests.length } };
    })
    .get("/api/approvals/:id", async ({ params, set }) => {
      if (!approvalEngine) {
        set.status = 501;
        return { success: false, error: { message: "Approval engine not configured." } };
      }
      const request = await approvalEngine.store.getById(params.id);
      if (!request) {
        set.status = 404;
        return { success: false, error: { message: `Approval ${params.id} not found.` } };
      }
      return { success: true, data: request };
    })
    .post("/api/approvals/:id/approve", async ({ params, body, request, set }) => {
      if (!approvalEngine) {
        set.status = 501;
        return { success: false, error: { message: "Approval engine not configured." } };
      }
      const actor = await resolveActor(request, resolveRequestActor);
      const { note } = (body ?? {}) as { note?: string };
      try {
        const result = await approvalEngine.approve(
          { approvalId: params.id, note },
          actor,
        );
        return { success: true, data: result };
      } catch (err) {
        set.status = 400;
        return {
          success: false,
          error: { message: err instanceof Error ? err.message : String(err) },
        };
      }
    })
    .post("/api/approvals/:id/reject", async ({ params, body, request, set }) => {
      if (!approvalEngine) {
        set.status = 501;
        return { success: false, error: { message: "Approval engine not configured." } };
      }
      const actor = await resolveActor(request, resolveRequestActor);
      const { note } = (body ?? {}) as { note?: string };
      if (!note || note.trim() === "") {
        set.status = 400;
        return { success: false, error: { message: "Rejection note is required." } };
      }
      try {
        const result = await approvalEngine.reject(
          { approvalId: params.id, note },
          actor,
        );
        return { success: true, data: result };
      } catch (err) {
        set.status = 400;
        return {
          success: false,
          error: { message: err instanceof Error ? err.message : String(err) },
        };
      }
    });
}
