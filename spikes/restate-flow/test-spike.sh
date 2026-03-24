#!/bin/bash
# Restate + Bun + LinchKit Flow Spike Test Script
#
# Prerequisites:
#   docker-compose up restate  (Restate server on :8080/:9070)
#   bun run spikes/restate-flow/spike-workflow.ts  (workflow service on :9080)

set -e

RESTATE_ADMIN="http://localhost:9070"
RESTATE_INGRESS="http://localhost:8080"

echo "=== Step 1: Register workflow service with Restate ==="
curl -s -X POST "$RESTATE_ADMIN/deployments" \
  -H "Content-Type: application/json" \
  -d '{"uri": "http://host.docker.internal:9080"}' | head -c 500
echo ""

echo ""
echo "=== Step 2: Start a purchase flow (amount > 10000, needs approval) ==="
FLOW_ID="purchase-$(date +%s)"
echo "Flow ID: $FLOW_ID"
curl -s -X POST "$RESTATE_INGRESS/purchase-approval/$FLOW_ID/run" \
  -H "Content-Type: application/json" \
  -d "{\"purchaseId\": \"PO-001\", \"amount\": 25000, \"description\": \"Server hardware\"}" &
RUN_PID=$!
echo "Flow started (background), waiting 2s..."
sleep 2

echo ""
echo "=== Step 3: Check flow status (should be waiting_for_approval) ==="
curl -s "$RESTATE_INGRESS/purchase-approval/$FLOW_ID/status"
echo ""

echo ""
echo "=== Step 4: Send approval signal ==="
curl -s -X POST "$RESTATE_INGRESS/purchase-approval/$FLOW_ID/approve" \
  -H "Content-Type: application/json" \
  -d '{"approved": true, "approver": "manager@example.com"}'
echo ""

echo ""
echo "=== Step 5: Wait for flow completion ==="
wait $RUN_PID 2>/dev/null || true
sleep 1

echo ""
echo "=== Step 6: Check final status ==="
curl -s "$RESTATE_INGRESS/purchase-approval/$FLOW_ID/status"
echo ""

echo ""
echo "=== Step 7: Start a small purchase (amount < 10000, auto-approve) ==="
FLOW_ID2="purchase-small-$(date +%s)"
curl -s -X POST "$RESTATE_INGRESS/purchase-approval/$FLOW_ID2/run" \
  -H "Content-Type: application/json" \
  -d "{\"purchaseId\": \"PO-002\", \"amount\": 5000, \"description\": \"Office supplies\"}"
echo ""

echo ""
echo "=== Done! ==="
