/**
 * Restate + Bun + LinchKit Flow Spike
 *
 * Validates:
 * 1. Restate SDK works with Bun runtime
 * 2. Workflow with multiple step types (action, approval/awakeable, condition, parallel)
 * 3. Approval with timeout via awakeable.orTimeout()
 * 4. FlowDefinition → Restate workflow mapping feasibility
 *
 * Key learnings:
 * - DurablePromise (ctx.promise) does NOT support combinators (race/all/orTimeout)
 * - Awakeable (ctx.awakeable) returns RestatePromise which DOES support orTimeout
 * - For approval patterns: use awakeable + external resolve via awakeableId
 * - For simple signals (no timeout needed): DurablePromise is fine
 */
import * as restate from "@restatedev/restate-sdk";

// ── Simulated LinchKit engines ──────────────────────────

async function executeAction(
  actionName: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  console.log(`[LinchKit] Executing action: ${actionName}`, input);
  await new Promise((r) => setTimeout(r, 100));
  return { success: true, actionName, result: `${actionName} completed`, ...input };
}

async function callAIService(
  prompt: string,
  model: string,
): Promise<{ response: string; tokensUsed: number }> {
  console.log(`[LinchKit] AI call: model=${model}, prompt="${prompt}"`);
  await new Promise((r) => setTimeout(r, 50));
  return { response: `AI response for: ${prompt}`, tokensUsed: 150 };
}

// ── Spike workflow: Purchase Approval Flow ──────────────

const purchaseApproval = restate.workflow({
  name: "purchase-approval",
  handlers: {
    run: async (
      ctx: restate.WorkflowContext,
      input: { purchaseId: string; amount: number; description: string },
    ) => {
      const flowInstanceId = ctx.key;
      console.log(`\n[Flow] Starting purchase-approval, instance=${flowInstanceId}`);

      // Step 1: Action step
      const validateResult = await ctx.run("validate_purchase", () =>
        executeAction("validate_purchase", {
          purchaseId: input.purchaseId,
          amount: input.amount,
        }),
      );
      console.log("[Flow] Step 1 (validate) done:", validateResult);

      // Step 2: Condition step
      const needsApproval = input.amount > 10000;
      console.log(
        `[Flow] Step 2 (condition): amount=${input.amount}, needsApproval=${needsApproval}`,
      );

      if (needsApproval) {
        // Step 3: Approval step via awakeable (supports orTimeout)
        ctx.set("status", "waiting_for_approval");
        console.log("[Flow] Step 3 (approval): Waiting for manager approval...");

        const { id: awakeableId, promise: approvalPromise } = ctx.awakeable<{
          approved: boolean;
          approver: string;
        }>();

        // Store awakeableId so external callers can resolve it
        ctx.set("awakeableId", awakeableId);
        console.log(`[Flow] Step 3: awakeableId=${awakeableId}`);

        try {
          // 30s timeout for spike — production would be hours/days
          const approval = await approvalPromise.orTimeout(30_000);

          if (!approval.approved) {
            ctx.set("status", "rejected");
            return { status: "rejected", approver: approval.approver };
          }
          console.log(`[Flow] Step 3 (approval): Approved by ${approval.approver}`);
        } catch (e) {
          if (e instanceof restate.TimeoutError) {
            console.log("[Flow] Step 3 (approval): TIMEOUT — auto-rejecting");
            ctx.set("status", "timeout_rejected");
            return { status: "timeout_rejected" };
          }
          throw e;
        }
      }

      // Step 4: AI step
      const aiResult = await ctx.run("ai_summary", () =>
        callAIService(`Summarize purchase: ${input.description}, amount: ${input.amount}`, "fast"),
      );
      console.log("[Flow] Step 4 (AI) done:", aiResult);

      // Step 5: Parallel action steps
      const [notifyResult, logResult] = await restate.RestatePromise.all([
        ctx.run("send_notification", () =>
          executeAction("send_notification", {
            purchaseId: input.purchaseId,
            message: "Purchase approved",
          }),
        ),
        ctx.run("log_audit", () =>
          executeAction("log_audit", {
            purchaseId: input.purchaseId,
            summary: aiResult.response,
          }),
        ),
      ]);
      console.log("[Flow] Step 5 (parallel) done:", { notifyResult, logResult });

      ctx.set("status", "completed");
      return { status: "completed", purchaseId: input.purchaseId, aiSummary: aiResult.response };
    },

    // Signal handler — resolves the awakeable to approve/reject
    approve: async (
      ctx: restate.WorkflowSharedContext,
      data: { approved: boolean; approver: string },
    ) => {
      const awakeableId = await ctx.get<string>("awakeableId");
      if (!awakeableId) {
        throw new restate.TerminalError("No pending approval (awakeableId not found)");
      }
      console.log(`[Flow] Resolving approval awakeable: ${awakeableId}`, data);
      ctx.resolveAwakeable(awakeableId, data);
      return { acknowledged: true };
    },

    // Status query handler
    status: async (ctx: restate.WorkflowSharedContext) => {
      return (await ctx.get<string>("status")) ?? "unknown";
    },
  },
});

// ── Start the service on Bun ────────────────────────────

console.log("[Spike] Starting Restate workflow service on :9080 (Bun runtime)");
restate.endpoint().bind(purchaseApproval).listen(9080);
