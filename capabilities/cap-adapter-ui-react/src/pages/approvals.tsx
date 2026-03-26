/**
 * ApprovalsPage — Approval inbox listing pending approval requests.
 *
 * Displays a list of pending approvals assigned to the current user.
 * Each item shows record info, requester, submitted date, and approval level.
 * Clicking opens an approve/reject dialog inline.
 *
 * Spec ref: 35_approval_mechanism.md
 */

import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@linchkit/ui-kit/components";
import type { ColumnDef } from "@tanstack/react-table";
import {
  CheckCircle2Icon,
  ClockIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  XCircleIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AutoList, SortableHeader } from "@/components/auto-list";
import {
  type ApprovalRequestItem,
  type ApprovalStatus,
  approveRequest,
  fetchApprovals,
  rejectRequest,
} from "@/lib/approval-api";

// ── Status badge styling ────────────────────────────────

const STATUS_VARIANTS: Record<string, "default" | "destructive" | "outline" | "secondary"> = {
  pending: "outline",
  approved: "default",
  rejected: "destructive",
  expired: "secondary",
  cancelled: "secondary",
};

function ApprovalStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  const labels: Record<string, string> = {
    pending: t("approvals.statusPending"),
    approved: t("approvals.statusApproved"),
    rejected: t("approvals.statusRejected"),
    expired: t("approvals.statusExpired"),
    cancelled: t("approvals.statusCancelled"),
  };
  return <Badge variant={STATUS_VARIANTS[status] ?? "outline"}>{labels[status] ?? status}</Badge>;
}

// ── Formatters ───────────────────────────────────────────

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Approve/Reject Dialog ────────────────────────────────

function ApprovalActionDialog({
  approval,
  onClose,
  onSuccess,
}: {
  approval: ApprovalRequestItem;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"approve" | "reject" | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleApprove = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await approveRequest(approval.id, note || undefined);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleReject = async () => {
    if (!note.trim()) {
      setError(t("approvals.rejectNoteRequired"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await rejectRequest(approval.id, note);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheckIcon className="size-5" />
            {t("approvals.reviewTitle")}
          </DialogTitle>
          <DialogDescription>
            {approval.reason}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <span className="text-muted-foreground">{t("approvals.action")}:</span>{" "}
              <span className="font-mono text-xs">{approval.action}</span>
            </div>
            {approval.schema && (
              <div>
                <span className="text-muted-foreground">{t("approvals.schema")}:</span>{" "}
                <span>{approval.schema}</span>
              </div>
            )}
            <div>
              <span className="text-muted-foreground">{t("approvals.requester")}:</span>{" "}
              <span>{approval.requestedBy.id}</span>
            </div>
            <div>
              <span className="text-muted-foreground">{t("approvals.level")}:</span>{" "}
              <Badge variant="outline" className="ml-1 text-xs">{approval.level}</Badge>
            </div>
            <div>
              <span className="text-muted-foreground">{t("approvals.submittedAt")}:</span>{" "}
              <span>{formatDateTime(approval.createdAt)}</span>
            </div>
            {approval.expiresAt && (
              <div>
                <span className="text-muted-foreground">{t("approvals.expiresAt")}:</span>{" "}
                <span>{formatDateTime(approval.expiresAt)}</span>
              </div>
            )}
          </div>

          {/* Input data preview */}
          {approval.input && Object.keys(approval.input).length > 0 && (
            <div>
              <span className="text-muted-foreground text-xs">{t("approvals.inputData")}:</span>
              <pre className="bg-muted rounded p-2 text-xs overflow-auto max-h-32 mt-1">
                {JSON.stringify(approval.input, null, 2)}
              </pre>
            </div>
          )}

          {/* Note field */}
          {mode !== null && (
            <div>
              <Label htmlFor="approval-note">
                {mode === "reject" ? t("approvals.rejectNote") : t("approvals.approveNote")}
                {mode === "reject" && <span className="text-destructive ml-1">*</span>}
              </Label>
              <Textarea
                id="approval-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={
                  mode === "reject"
                    ? t("approvals.rejectNotePlaceholder")
                    : t("approvals.approveNotePlaceholder")
                }
                rows={3}
                className="mt-1"
              />
            </div>
          )}

          {error && (
            <div className="text-sm text-destructive bg-destructive/10 rounded p-2">
              {error}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          {mode === null ? (
            <>
              <Button
                variant="destructive"
                onClick={() => setMode("reject")}
                disabled={submitting}
              >
                <XCircleIcon className="size-4 mr-1" />
                {t("approvals.reject")}
              </Button>
              <Button
                onClick={() => setMode("approve")}
                disabled={submitting}
              >
                <CheckCircle2Icon className="size-4 mr-1" />
                {t("approvals.approve")}
              </Button>
            </>
          ) : mode === "approve" ? (
            <>
              <Button variant="outline" onClick={() => setMode(null)} disabled={submitting}>
                {t("common.back")}
              </Button>
              <Button onClick={handleApprove} disabled={submitting}>
                {submitting ? t("common.submitting") : t("approvals.confirmApprove")}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setMode(null)} disabled={submitting}>
                {t("common.back")}
              </Button>
              <Button
                variant="destructive"
                onClick={handleReject}
                disabled={submitting}
              >
                {submitting ? t("common.submitting") : t("approvals.confirmReject")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main Page Component ──────────────────────────────────

export function ApprovalsPage() {
  const { t } = useTranslation();
  const [approvals, setApprovals] = useState<ApprovalRequestItem[]>([]);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState<string>("pending");
  const [loading, setLoading] = useState(false);
  const [selectedApproval, setSelectedApproval] = useState<ApprovalRequestItem | null>(null);

  const loadApprovals = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchApprovals(statusFilter as ApprovalStatus);
      setApprovals(result.items);
      setTotal(result.total);
    } catch {
      setApprovals([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    loadApprovals();
  }, [loadApprovals]);

  const columns = useMemo<ColumnDef<Record<string, unknown>, unknown>[]>(
    () => [
      {
        accessorKey: "createdAt",
        header: ({ column }) => (
          <SortableHeader column={column} label={t("approvals.submittedAt")} />
        ),
        cell: ({ row }) => {
          const entry = row.original as unknown as ApprovalRequestItem;
          return (
            <div className="flex items-center gap-1 text-muted-foreground text-xs">
              <ClockIcon className="size-3" />
              <span title={formatDateTime(entry.createdAt)}>
                {formatRelativeTime(entry.createdAt)}
              </span>
            </div>
          );
        },
      },
      {
        accessorKey: "action",
        header: ({ column }) => (
          <SortableHeader column={column} label={t("approvals.action")} />
        ),
        cell: ({ row }) => {
          const entry = row.original as unknown as ApprovalRequestItem;
          return (
            <div>
              <div className="font-mono text-xs">{entry.action}</div>
              {entry.schema && (
                <div className="text-xs text-muted-foreground">
                  {entry.schema}
                  {entry.recordId && `/${entry.recordId}`}
                </div>
              )}
            </div>
          );
        },
      },
      {
        accessorKey: "requestedBy",
        header: t("approvals.requester"),
        cell: ({ row }) => {
          const entry = row.original as unknown as ApprovalRequestItem;
          return (
            <span className="text-xs">
              {entry.requestedBy.id}
              <span className="text-muted-foreground ml-1">({entry.requestedBy.type})</span>
            </span>
          );
        },
        accessorFn: (row) => {
          const entry = row as unknown as ApprovalRequestItem;
          return entry.requestedBy.id;
        },
      },
      {
        accessorKey: "level",
        header: t("approvals.level"),
        cell: ({ row }) => {
          const entry = row.original as unknown as ApprovalRequestItem;
          return (
            <Badge variant="outline" className="text-xs">
              {entry.level}
            </Badge>
          );
        },
      },
      {
        accessorKey: "reason",
        header: t("approvals.reason"),
        cell: ({ row }) => {
          const entry = row.original as unknown as ApprovalRequestItem;
          return (
            <span className="text-xs text-muted-foreground line-clamp-2" title={entry.reason}>
              {entry.reason}
            </span>
          );
        },
      },
      {
        accessorKey: "status",
        header: ({ column }) => (
          <SortableHeader column={column} label={t("approvals.status")} />
        ),
        cell: ({ row }) => (
          <ApprovalStatusBadge status={row.getValue("status") as string} />
        ),
      },
      {
        id: "actions",
        header: "",
        size: 100,
        cell: ({ row }) => {
          const entry = row.original as unknown as ApprovalRequestItem;
          if (entry.status !== "pending") return null;
          return (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={(e) => {
                e.stopPropagation();
                setSelectedApproval(entry);
              }}
            >
              <ShieldCheckIcon className="size-3 mr-1" />
              {t("approvals.review")}
            </Button>
          );
        },
      },
    ],
    [t],
  );

  const tableData = useMemo<Record<string, unknown>[]>(
    () => approvals.map((a) => ({ ...a }) as Record<string, unknown>),
    [approvals],
  );

  return (
    <div className="p-4">
      <AutoList
        columns={columns}
        data={tableData}
        pageSize={20}
        defaultSorting={[{ id: "createdAt", desc: true }]}
        loading={loading}
        emptyState={{
          title: t("emptyState.approvals.title"),
          description: t("emptyState.approvals.description"),
        }}
        onRowClick={(id) => {
          const approval = approvals.find((a) => a.id === id);
          if (approval?.status === "pending") {
            setSelectedApproval(approval);
          }
        }}
        toolbarExtra={
          <>
            <Select
              value={statusFilter}
              onValueChange={(v) => setStatusFilter(v)}
            >
              <SelectTrigger className="w-40 h-7 text-[0.8rem]">
                <SelectValue placeholder={t("approvals.allStatuses")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pending">{t("approvals.statusPending")}</SelectItem>
                <SelectItem value="approved">{t("approvals.statusApproved")}</SelectItem>
                <SelectItem value="rejected">{t("approvals.statusRejected")}</SelectItem>
                <SelectItem value="expired">{t("approvals.statusExpired")}</SelectItem>
                <SelectItem value="cancelled">{t("approvals.statusCancelled")}</SelectItem>
              </SelectContent>
            </Select>
            <span className="text-sm text-muted-foreground">
              {total} {t("approvals.entries")}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={loadApprovals}
              disabled={loading}
              title={t("common.refresh")}
            >
              <RefreshCwIcon className={`size-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </>
        }
      />

      {selectedApproval && (
        <ApprovalActionDialog
          approval={selectedApproval}
          onClose={() => setSelectedApproval(null)}
          onSuccess={() => {
            setSelectedApproval(null);
            loadApprovals();
          }}
        />
      )}
    </div>
  );
}
