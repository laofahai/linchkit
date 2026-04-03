/**
 * MCP Clients list page — Table with CRUD operations.
 *
 * Route: /admin/mcp/clients
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
  Input,
  Label,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "@linchkit/ui-kit/components";
import { CheckIcon, CopyIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CreateMcpClientResult, McpClient } from "../lib/api";
import { createMcpClient, deleteMcpClient, fetchMcpClients, toggleMcpClient } from "../lib/api";

// ── Component ──────────────────────────────────────────

export function McpClients() {
  const { t } = useTranslation();
  const [clients, setClients] = useState<McpClient[]>([]);
  const [loading, setLoading] = useState(true);

  // Create dialog state
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createGroups, setCreateGroups] = useState("");
  const [creating, setCreating] = useState(false);

  // Secret display dialog
  const [secretResult, setSecretResult] = useState<CreateMcpClientResult | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);

  // Delete confirmation dialog
  const [deleteTarget, setDeleteTarget] = useState<McpClient | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadClients = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchMcpClients();
      setClients(data);
    } catch {
      setClients([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadClients();
  }, [loadClients]);

  // ── Create handler ─────────────────────────────────

  const handleCreate = async () => {
    if (!createName.trim()) return;
    setCreating(true);
    try {
      const groups = createGroups
        .split(",")
        .map((g) => g.trim())
        .filter(Boolean);
      const result = await createMcpClient({
        name: createName.trim(),
        description: createDescription.trim() || undefined,
        actorGroups: groups.length > 0 ? groups : undefined,
      });
      setSecretResult(result);
      setShowCreate(false);
      resetCreateForm();
      await loadClients();
    } catch (err) {
      console.error("Failed to create MCP client:", err);
    } finally {
      setCreating(false);
    }
  };

  const resetCreateForm = () => {
    setCreateName("");
    setCreateDescription("");
    setCreateGroups("");
  };

  // ── Delete handler ─────────────────────────────────

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteMcpClient(deleteTarget.id);
      setDeleteTarget(null);
      await loadClients();
    } catch (err) {
      console.error("Failed to delete MCP client:", err);
    } finally {
      setDeleting(false);
    }
  };

  // ── Toggle handler ─────────────────────────────────

  const handleToggle = async (client: McpClient) => {
    try {
      const result = await toggleMcpClient(client.id, !client.enabled);
      setClients((prev) =>
        prev.map((c) => (c.id === client.id ? { ...c, enabled: result.enabled } : c)),
      );
    } catch (err) {
      console.error("Failed to toggle MCP client:", err);
    }
  };

  // ── Copy secret ────────────────────────────────────

  const copySecret = async (secret: string) => {
    await navigator.clipboard.writeText(secret);
    setSecretCopied(true);
    setTimeout(() => setSecretCopied(false), 2000);
  };

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">{t("mcp.admin.clients")}</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={loadClients} disabled={loading}>
            <RefreshCwIcon className={`size-4 mr-1 ${loading ? "animate-spin" : ""}`} />
            {t("common.refresh", "Refresh")}
          </Button>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <PlusIcon className="size-4 mr-1" />
            {t("mcp.admin.client.create")}
          </Button>
        </div>
      </div>

      {/* Clients table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("mcp.admin.client.name")}</TableHead>
              <TableHead>{t("mcp.admin.client.clientId")}</TableHead>
              <TableHead>{t("mcp.admin.client.status")}</TableHead>
              <TableHead>{t("mcp.admin.client.lastUsed")}</TableHead>
              <TableHead className="text-right">{t("common.actions", "Actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {clients.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground h-24">
                  {loading
                    ? t("common.loading", "Loading...")
                    : t("mcp.admin.client.noClients", "No MCP clients registered")}
                </TableCell>
              </TableRow>
            ) : (
              clients.map((client) => (
                <TableRow key={client.id}>
                  <TableCell>
                    <a
                      href={`/admin/mcp/clients/${client.id}`}
                      className="font-medium hover:underline"
                    >
                      {client.name}
                    </a>
                    {client.description && (
                      <p className="text-xs text-muted-foreground truncate max-w-[200px]">
                        {client.description}
                      </p>
                    )}
                  </TableCell>
                  <TableCell>
                    <code className="text-xs bg-muted px-1 py-0.5 rounded">{client.clientId}</code>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={client.enabled}
                        onCheckedChange={() => handleToggle(client)}
                      />
                      <Badge variant={client.enabled ? "default" : "secondary"}>
                        {client.enabled
                          ? t("mcp.admin.client.enabled")
                          : t("mcp.admin.client.disabled")}
                      </Badge>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {client.lastUsedAt
                      ? new Date(client.lastUsedAt).toLocaleString()
                      : t("mcp.admin.client.never")}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setDeleteTarget(client)}
                    >
                      <Trash2Icon className="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Create dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("mcp.admin.client.create")}</DialogTitle>
            <DialogDescription>
              {t(
                "mcp.admin.client.createDescription",
                "Create a new MCP client credential for external tools.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="client-name">{t("mcp.admin.client.name")}</Label>
              <Input
                id="client-name"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="e.g. Claude Desktop"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="client-desc">{t("mcp.admin.client.description")}</Label>
              <Textarea
                id="client-desc"
                value={createDescription}
                onChange={(e) => setCreateDescription(e.target.value)}
                placeholder="Optional description"
                rows={2}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="client-groups">{t("mcp.admin.client.actorGroups")}</Label>
              <Input
                id="client-groups"
                value={createGroups}
                onChange={(e) => setCreateGroups(e.target.value)}
                placeholder="admin, editor (comma-separated)"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreate(false)}>
              {t("common.cancel", "Cancel")}
            </Button>
            <Button onClick={handleCreate} disabled={creating || !createName.trim()}>
              {creating ? t("common.creating", "Creating...") : t("mcp.admin.client.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Secret display dialog */}
      <Dialog
        open={secretResult !== null}
        onOpenChange={(open) => {
          if (!open) setSecretResult(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("mcp.admin.client.create")}</DialogTitle>
            <DialogDescription>{t("mcp.admin.client.secretWarning")}</DialogDescription>
          </DialogHeader>
          {secretResult && (
            <div className="space-y-3 py-2">
              <div className="space-y-1">
                <Label>{t("mcp.admin.client.clientId")}</Label>
                <code className="block text-sm bg-muted p-2 rounded break-all">
                  {secretResult.clientId}
                </code>
              </div>
              <div className="space-y-1">
                <Label>Secret</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-sm bg-muted p-2 rounded break-all font-mono">
                    {secretResult.clientSecret}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => copySecret(secretResult.clientSecret)}
                  >
                    {secretCopied ? (
                      <CheckIcon className="size-4" />
                    ) : (
                      <CopyIcon className="size-4" />
                    )}
                  </Button>
                </div>
                {secretCopied && (
                  <p className="text-xs text-green-600">{t("mcp.admin.client.secretCopied")}</p>
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setSecretResult(null)}>{t("common.done", "Done")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("common.confirm", "Confirm")}</DialogTitle>
            <DialogDescription>{t("mcp.admin.client.deleteConfirm")}</DialogDescription>
          </DialogHeader>
          {deleteTarget && (
            <p className="text-sm py-2">
              <strong>{deleteTarget.name}</strong> ({deleteTarget.clientId})
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              {t("common.cancel", "Cancel")}
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? t("common.deleting", "Deleting...") : t("common.delete", "Delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default McpClients;
