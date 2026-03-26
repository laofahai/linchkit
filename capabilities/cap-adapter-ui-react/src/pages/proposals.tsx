/**
 * AI Proposals Page — /admin/proposals
 *
 * Lists all AI-generated proposals using AutoList with status filtering,
 * approval/rejection actions, and detail view for each proposal.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  toast,
} from "@linchkit/ui-kit/components";
import type { ColumnDef } from "@tanstack/react-table";
import {
  BotIcon,
  CheckCircle2,
  ClockIcon,
  CodeIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  UserIcon,
  XCircleIcon,
  ZapIcon,
} from "lucide-react";
import {
  type Proposal,
  approveProposal,
  fetchProposals,
  rejectProposal,
} from "@/lib/proposal-api";
import { AutoList, SortableHeader } from "@/components/auto-list";

// ── Status badge ─────────────────────────────────────────

function ProposalStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  const config: Record<string, { label: string; className: string }> = {
    draft: {
      label: t("proposals.status.draft"),
      className: "text-yellow-600 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-950",
    },
    validating: {
      label: t("proposals.status.validating"),
      className: "text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950",
    },
    validated: {
      label: t("proposals.status.validated"),
      className: "text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950",
    },
    approved: {
      label: t("proposals.status.approved"),
      className: "text-green-600 dark:text-green-400 border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950",
    },
    rejected: {
      label: t("proposals.status.rejected"),
      className: "text-red-600 dark:text-red-400 border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950",
    },
    committed: {
      label: t("proposals.status.committed"),
      className: "text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-800 bg-purple-50 dark:bg-purple-950",
    },
    deployed: {
      label: t("proposals.status.deployed"),
      className: "text-green-600 dark:text-green-400 border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950",
    },
  };

  const cfg = config[status] ?? { label: status, className: "" };

  return (
    <Badge variant="outline" className={`gap-1 ${cfg.className}`}>
      {status === "approved" || status === "deployed" ? <CheckCircle2 className="h-3 w-3" /> : null}
      {status === "rejected" ? <XCircleIcon className="h-3 w-3" /> : null}
      {status === "draft" || status === "validated" ? <ClockIcon className="h-3 w-3" /> : null}
      {cfg.label}
    </Badge>
  );
}

// ── Change type badge ────────────────────────────────────

function ChangeTypeBadge({ changeType }: { changeType: string }) {
  const colors: Record<string, string> = {
    patch: "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300",
    minor: "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300",
    major: "bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300",
  };

  return (
    <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${colors[changeType] ?? ""}`}>
      {changeType}
    </span>
  );
}

// ── Proposal detail dialog ───────────────────────────────

function ProposalDetailDialog({
  proposal,
  open,
  onClose,
  onApprove,
  onReject,
}: {
  proposal: Proposal | null;
  open: boolean;
  onClose: () => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (!proposal) return null;

  const isPending = proposal.status === "draft" || proposal.status === "validated";

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {proposal.author.type === "ai" ? (
              <BotIcon className="h-5 w-5 text-purple-500" />
            ) : (
              <UserIcon className="h-5 w-5 text-blue-500" />
            )}
            {proposal.title}
          </DialogTitle>
          <DialogDescription>{proposal.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Meta info */}
          <div className="flex flex-wrap gap-2">
            <ProposalStatusBadge status={proposal.status} />
            <ChangeTypeBadge changeType={proposal.changeType} />
            <Badge variant="outline" className="gap-1">
              <CodeIcon className="h-3 w-3" />
              {proposal.capability}
            </Badge>
          </div>

          <Separator />

          {/* Changes */}
          <div>
            <h4 className="text-sm font-medium mb-2">{t("proposals.changes")}</h4>
            <div className="space-y-2">
              {proposal.changes.map((change, i) => (
                <div
                  key={`${change.name}-${i}`}
                  className="rounded-md border p-3 text-sm"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant="outline" className="text-[10px]">
                      {change.operation}
                    </Badge>
                    <span className="font-medium">{change.target}</span>
                    <span className="text-muted-foreground">/ {change.name}</span>
                  </div>
                  {change.diff && (
                    <p className="text-xs text-muted-foreground mt-1 font-mono bg-muted/50 rounded px-2 py-1">
                      {change.diff}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>

          <Separator />

          {/* Impact */}
          <div>
            <h4 className="text-sm font-medium mb-2">{t("proposals.impact")}</h4>
            <div className="grid grid-cols-2 gap-2 text-sm">
              {proposal.impact.schemasAffected.length > 0 && (
                <div>
                  <span className="text-muted-foreground">{t("proposals.schemasAffected")}:</span>{" "}
                  {proposal.impact.schemasAffected.join(", ")}
                </div>
              )}
              {proposal.impact.actionsAffected.length > 0 && (
                <div>
                  <span className="text-muted-foreground">{t("proposals.actionsAffected")}:</span>{" "}
                  {proposal.impact.actionsAffected.join(", ")}
                </div>
              )}
              {proposal.impact.rulesAffected.length > 0 && (
                <div>
                  <span className="text-muted-foreground">{t("proposals.rulesAffected")}:</span>{" "}
                  {proposal.impact.rulesAffected.join(", ")}
                </div>
              )}
              <div>
                <span className="text-muted-foreground">{t("proposals.migrationRequired")}:</span>{" "}
                {proposal.impact.migrationRequired ? t("common.yes") : t("common.no")}
              </div>
            </div>
          </div>

          {/* Validation result */}
          {proposal.validationResult && (
            <>
              <Separator />
              <div>
                <h4 className="text-sm font-medium mb-2">{t("proposals.validation")}</h4>
                <div className="space-y-1">
                  {proposal.validationResult.phases.map((phase) => (
                    <div key={phase.phase} className="flex items-center gap-2 text-sm">
                      {phase.status === "passed" ? (
                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                      ) : (
                        <XCircleIcon className="h-4 w-4 text-red-500" />
                      )}
                      <span>Phase {phase.phase}: {phase.status}</span>
                      {phase.errors.length > 0 && (
                        <span className="text-red-500 text-xs">
                          ({phase.errors.length} error{phase.errors.length > 1 ? "s" : ""})
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* Rejection reason */}
          {proposal.rejectionReason && (
            <>
              <Separator />
              <div className="rounded-md bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 p-3">
                <h4 className="text-sm font-medium text-red-700 dark:text-red-300 mb-1">
                  {t("proposals.rejectionReason")}
                </h4>
                <p className="text-sm text-red-600 dark:text-red-400">{proposal.rejectionReason}</p>
              </div>
            </>
          )}
        </div>

        {isPending && (
          <DialogFooter>
            <Button variant="outline" onClick={() => onReject(proposal.id)}>
              <XCircleIcon className="h-4 w-4 mr-1" />
              {t("proposals.reject")}
            </Button>
            <Button onClick={() => onApprove(proposal.id)}>
              <CheckCircle2 className="h-4 w-4 mr-1" />
              {t("proposals.approve")}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Main Page ────────────────────────────────────────────

export function ProposalsPage() {
  const { t } = useTranslation();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedProposal, setSelectedProposal] = useState<Proposal | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const loadProposals = async () => {
    setLoading(true);
    try {
      const status = statusFilter === "all" ? undefined : statusFilter;
      const result = await fetchProposals(status);
      setProposals(result.items);
    } catch {
      setProposals([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProposals();
  }, [statusFilter]);

  const handleApprove = async (id: string) => {
    try {
      await approveProposal(id);
      toast.success(t("proposals.approveSuccess"));
      setDialogOpen(false);
      loadProposals();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("proposals.approveFailed"));
    }
  };

  const handleReject = async (id: string) => {
    try {
      await rejectProposal(id, "Rejected by user");
      toast.success(t("proposals.rejectSuccess"));
      setDialogOpen(false);
      loadProposals();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("proposals.rejectFailed"));
    }
  };

  const pendingCount = proposals.filter(
    (p) => p.status === "draft" || p.status === "validated",
  ).length;

  // Build AutoList column defs
  const columns = useMemo<ColumnDef<Record<string, unknown>, unknown>[]>(() => [
    {
      accessorKey: "title",
      header: ({ column }) => <SortableHeader column={column} label={t("proposals.columns.title", { defaultValue: "Title" })} />,
      cell: ({ row }) => {
        const p = row.original as unknown as Proposal;
        return (
          <div className="flex items-center gap-2">
            {p.author.type === "ai" ? (
              <BotIcon className="h-4 w-4 text-purple-500 shrink-0" />
            ) : (
              <UserIcon className="h-4 w-4 text-blue-500 shrink-0" />
            )}
            <div className="min-w-0">
              <div className="font-medium text-sm truncate">{p.title}</div>
              <div className="text-xs text-muted-foreground truncate">{p.description}</div>
            </div>
          </div>
        );
      },
    },
    {
      accessorKey: "status",
      header: ({ column }) => <SortableHeader column={column} label={t("proposals.columns.status", { defaultValue: "Status" })} />,
      cell: ({ row }) => <ProposalStatusBadge status={row.getValue("status") as string} />,
      size: 130,
    },
    {
      accessorKey: "changeType",
      header: t("proposals.columns.changeType", { defaultValue: "Type" }),
      cell: ({ row }) => <ChangeTypeBadge changeType={row.getValue("changeType") as string} />,
      size: 80,
    },
    {
      accessorKey: "capability",
      header: ({ column }) => <SortableHeader column={column} label={t("proposals.columns.capability", { defaultValue: "Capability" })} />,
      cell: ({ row }) => (
        <Badge variant="outline" className="gap-1 text-xs">
          <CodeIcon className="h-3 w-3" />
          {row.getValue("capability") as string}
        </Badge>
      ),
      size: 160,
    },
    {
      accessorKey: "author",
      header: t("proposals.columns.author", { defaultValue: "Author" }),
      cell: ({ row }) => {
        const p = row.original as unknown as Proposal;
        return <span className="text-xs text-muted-foreground">{p.author.name ?? p.author.id}</span>;
      },
      accessorFn: (row) => {
        const p = row as unknown as Proposal;
        return p.author.name ?? p.author.id;
      },
      size: 120,
    },
    {
      accessorKey: "createdAt",
      header: ({ column }) => <SortableHeader column={column} label={t("proposals.columns.date", { defaultValue: "Date" })} />,
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {new Date(row.getValue("createdAt") as string).toLocaleDateString()}
        </span>
      ),
      size: 100,
    },
    {
      id: "actions",
      header: "",
      size: 160,
      cell: ({ row }) => {
        const p = row.original as unknown as Proposal;
        const isPending = p.status === "draft" || p.status === "validated";
        if (!isPending) return null;
        return (
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs text-red-600 hover:text-red-700"
              onClick={() => handleReject(p.id)}
            >
              {t("proposals.reject")}
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => handleApprove(p.id)}
            >
              {t("proposals.approve")}
            </Button>
          </div>
        );
      },
    },
  ], [t]);

  // Convert proposals to DataRow for AutoList
  const tableData = useMemo<Record<string, unknown>[]>(
    () => proposals.map((p) => ({ ...p }) as Record<string, unknown>),
    [proposals],
  );

  return (
    <div className="space-y-6 p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
            <ZapIcon className="h-5 w-5 text-purple-500" />
            {t("proposals.title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("proposals.subtitle")}
          </p>
        </div>
      </div>

      {/* Pending count banner */}
      {pendingCount > 0 && (
        <Card className="border-yellow-200 dark:border-yellow-800 bg-yellow-50/50 dark:bg-yellow-950/50">
          <CardContent className="py-3 flex items-center gap-3">
            <ShieldAlertIcon className="h-5 w-5 text-yellow-600 dark:text-yellow-400" />
            <span className="text-sm font-medium text-yellow-700 dark:text-yellow-300">
              {t("proposals.pendingBanner", { count: pendingCount })}
            </span>
          </CardContent>
        </Card>
      )}

      <AutoList
        externalColumns={columns}
        data={tableData}
        pageSize={20}
        defaultSorting={[{ id: "createdAt", desc: true }]}
        loading={loading}
        onRowClick={(id) => {
          const p = proposals.find((p) => p.id === id);
          if (p) {
            setSelectedProposal(p);
            setDialogOpen(true);
          }
        }}
        toolbarExtra={
          <>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-36 h-7 text-[0.8rem]">
                <SelectValue placeholder={t("proposals.filter.all")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("proposals.filter.all")}</SelectItem>
                <SelectItem value="draft">{t("proposals.filter.pending")}</SelectItem>
                <SelectItem value="approved">{t("proposals.filter.approved")}</SelectItem>
                <SelectItem value="rejected">{t("proposals.filter.rejected")}</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="icon-sm" onClick={loadProposals} disabled={loading} title={t("executionLog.refresh")}>
              <RefreshCwIcon className={`size-4 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </>
        }
      />

      {/* Detail dialog */}
      <ProposalDetailDialog
        proposal={selectedProposal}
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onApprove={handleApprove}
        onReject={handleReject}
      />
    </div>
  );
}
