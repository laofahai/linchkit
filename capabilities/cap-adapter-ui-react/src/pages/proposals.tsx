/**
 * AI Proposals Page — /admin/proposals
 *
 * Lists all AI-generated proposals with status filtering, approval/rejection actions,
 * and detail view for each proposal showing changes, impact, and validation results.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Separator,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from "@linchkit/ui-kit/components";
import {
  BotIcon,
  CheckCircle2,
  ChevronRight,
  ClockIcon,
  CodeIcon,
  FileTextIcon,
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

// ── Proposal list item ───────────────────────────────────

function ProposalItem({
  proposal,
  onClick,
  onApprove,
  onReject,
}: {
  proposal: Proposal;
  onClick: () => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const { t } = useTranslation();
  const isPending = proposal.status === "draft" || proposal.status === "validated";

  return (
    <div
      className="flex items-start gap-4 rounded-lg border p-4 transition-colors hover:bg-accent/50 cursor-pointer"
      onClick={onClick}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
      tabIndex={0}
      role="button"
    >
      {/* Icon */}
      <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-purple-100 dark:bg-purple-900">
        {proposal.author.type === "ai" ? (
          <BotIcon className="h-5 w-5 text-purple-600 dark:text-purple-400" />
        ) : (
          <UserIcon className="h-5 w-5 text-blue-600 dark:text-blue-400" />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <span className="font-medium text-sm">{proposal.title}</span>
          <ProposalStatusBadge status={proposal.status} />
          <ChangeTypeBadge changeType={proposal.changeType} />
        </div>
        <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
          {proposal.description}
        </p>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <CodeIcon className="h-3 w-3" />
            {proposal.capability}
          </span>
          <span className="flex items-center gap-1">
            <ClockIcon className="h-3 w-3" />
            {new Date(proposal.createdAt).toLocaleDateString()}
          </span>
          <span>
            {proposal.changes.length} {t("proposals.changeCount")}
          </span>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
        {isPending && (
          <>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs text-red-600 hover:text-red-700"
              onClick={() => onReject(proposal.id)}
            >
              {t("proposals.reject")}
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => onApprove(proposal.id)}
            >
              {t("proposals.approve")}
            </Button>
          </>
        )}
        <ChevronRight className="h-4 w-4 text-muted-foreground ml-1" />
      </div>
    </div>
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
        <Button variant="outline" size="sm" onClick={loadProposals}>
          <RefreshCwIcon className="h-4 w-4 mr-1" />
          {t("executionLog.refresh")}
        </Button>
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

      {/* Status filter tabs */}
      <Tabs value={statusFilter} onValueChange={setStatusFilter}>
        <TabsList>
          <TabsTrigger value="all">{t("proposals.filter.all")}</TabsTrigger>
          <TabsTrigger value="draft">{t("proposals.filter.pending")}</TabsTrigger>
          <TabsTrigger value="approved">{t("proposals.filter.approved")}</TabsTrigger>
          <TabsTrigger value="rejected">{t("proposals.filter.rejected")}</TabsTrigger>
        </TabsList>

        <TabsContent value={statusFilter} className="mt-4">
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="rounded-lg border p-4">
                  <Skeleton className="h-5 w-64 mb-2" />
                  <Skeleton className="h-4 w-96 mb-2" />
                  <Skeleton className="h-3 w-48" />
                </div>
              ))}
            </div>
          ) : proposals.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <FileTextIcon className="h-12 w-12 text-muted-foreground mx-auto mb-3 opacity-50" />
                <p className="text-sm text-muted-foreground">
                  {t("proposals.noProposals")}
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {proposals.map((proposal) => (
                <ProposalItem
                  key={proposal.id}
                  proposal={proposal}
                  onClick={() => {
                    setSelectedProposal(proposal);
                    setDialogOpen(true);
                  }}
                  onApprove={handleApprove}
                  onReject={handleReject}
                />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

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
