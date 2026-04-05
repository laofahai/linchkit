/**
 * MCP Client Detail page — View and edit a single MCP client.
 *
 * Route: /admin/mcp/clients/:id
 */

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Separator,
  Textarea,
} from "@linchkit/ui-kit/components";
import { ArrowLeftIcon, CheckIcon, CopyIcon, KeyIcon, Loader2Icon, SaveIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ToolPolicyEditor } from "../components/tool-policy-editor";
import type { CreateMcpClientResult, McpClient, ToolPolicy } from "../lib/api";
import { fetchMcpClient, rotateMcpClientSecret, updateMcpClient } from "../lib/api";

// ── Helpers ────────────────────────────────────────────

/** Extract client ID from URL path */
function getClientIdFromUrl(): string {
  const parts = window.location.pathname.split("/");
  return parts[parts.length - 1] ?? "";
}

// ── Component ──────────────────────────────────────────

export function McpClientDetail() {
  const { t } = useTranslation();
  const [client, setClient] = useState<McpClient | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Editable form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [actorGroups, setActorGroups] = useState("");
  const [toolPolicy, setToolPolicy] = useState<ToolPolicy>({ mode: "allow_all" });

  // Secret rotation
  const [showRotate, setShowRotate] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateResult, setRotateResult] = useState<CreateMcpClientResult | null>(null);
  const [secretCopied, setSecretCopied] = useState(false);

  const clientId = getClientIdFromUrl();

  const loadClient = useCallback(async () => {
    if (!clientId) return;
    setLoading(true);
    try {
      const data = await fetchMcpClient(clientId);
      if (data) {
        setClient(data);
        setName(data.name);
        setDescription(data.description ?? "");
        setActorGroups((data.actorGroups ?? []).join(", "));
        setToolPolicy((data.toolPolicy as ToolPolicy) ?? { mode: "allow_all" });
      }
    } catch (err) {
      console.error("Failed to load MCP client:", err);
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    loadClient();
  }, [loadClient]);

  // ── Save handler ───────────────────────────────────

  const handleSave = async () => {
    if (!client) return;
    setSaving(true);
    setSaved(false);
    try {
      const groups = actorGroups
        .split(",")
        .map((g) => g.trim())
        .filter(Boolean);
      const updated = await updateMcpClient(client.id, {
        name: name.trim(),
        description: description.trim() || undefined,
        actorGroups: groups.length > 0 ? groups : undefined,
        toolPolicy,
      });
      setClient(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      console.error("Failed to update MCP client:", err);
    } finally {
      setSaving(false);
    }
  };

  // ── Secret rotation handler ────────────────────────

  const handleRotate = async () => {
    if (!client) return;
    setRotating(true);
    try {
      const result = await rotateMcpClientSecret(client.id);
      setRotateResult(result);
      setShowRotate(false);
    } catch (err) {
      console.error("Failed to rotate secret:", err);
    } finally {
      setRotating(false);
    }
  };

  const copySecret = async (secret: string) => {
    await navigator.clipboard.writeText(secret);
    setSecretCopied(true);
    setTimeout(() => setSecretCopied(false), 2000);
  };

  // ── Loading state ──────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!client) {
    return (
      <div className="p-4">
        <p className="text-muted-foreground">{t("common.notFound", "Client not found")}</p>
        <Button variant="outline" className="mt-4" asChild>
          <a href="/admin/mcp/clients">
            <ArrowLeftIcon className="size-4 mr-1" />
            {t("common.back", "Back")}
          </a>
        </Button>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" asChild>
            <a href="/admin/mcp/clients">
              <ArrowLeftIcon className="size-4" />
            </a>
          </Button>
          <div>
            <h1 className="text-lg font-semibold">{client.name}</h1>
            <p className="text-sm text-muted-foreground">
              <code>{client.clientId}</code>
            </p>
          </div>
        </div>
        <Badge variant={client.enabled ? "default" : "secondary"}>
          {client.enabled ? t("mcp.admin.client.enabled") : t("mcp.admin.client.disabled")}
        </Badge>
      </div>

      {/* Basic info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("mcp.admin.clientDetail")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="detail-name">{t("mcp.admin.client.name")}</Label>
            <Input id="detail-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="detail-desc">{t("mcp.admin.client.description")}</Label>
            <Textarea
              id="detail-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t("mcp.admin.client.actorType")}</Label>
              <p className="text-sm text-muted-foreground">{client.actorType ?? "—"}</p>
            </div>
            <div className="space-y-2">
              <Label>{t("mcp.admin.client.actorGroups")}</Label>
              <Input
                value={actorGroups}
                onChange={(e) => setActorGroups(e.target.value)}
                placeholder="admin, editor"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 text-sm text-muted-foreground">
            <div>
              {t("mcp.admin.client.createdAt")}: {new Date(client.createdAt).toLocaleString()}
            </div>
            <div>
              {t("mcp.admin.client.lastUsed")}:{" "}
              {client.lastUsedAt
                ? new Date(client.lastUsedAt).toLocaleString()
                : t("mcp.admin.client.never")}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tool Policy */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("mcp.admin.toolPolicy.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ToolPolicyEditor value={toolPolicy} onChange={setToolPolicy} />
        </CardContent>
      </Card>

      {/* Security */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("mcp.admin.client.security", "Security")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => setShowRotate(true)}>
            <KeyIcon className="size-4 mr-1" />
            {t("mcp.admin.client.rotateSecret")}
          </Button>
        </CardContent>
      </Card>

      {/* Usage stats (stub) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            {t("mcp.admin.client.usage", "Usage Statistics")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {t("mcp.admin.client.usageStub", "Usage statistics coming soon.")}
          </p>
        </CardContent>
      </Card>

      <Separator />

      {/* Save button */}
      <div className="flex items-center gap-2">
        <Button onClick={handleSave} disabled={saving}>
          {saving ? (
            <Loader2Icon className="size-4 mr-1 animate-spin" />
          ) : (
            <SaveIcon className="size-4 mr-1" />
          )}
          {t("mcp.admin.client.save")}
        </Button>
        {saved && <span className="text-sm text-green-600">{t("mcp.admin.client.saved")}</span>}
      </div>

      {/* Rotate secret confirmation dialog */}
      <Dialog open={showRotate} onOpenChange={setShowRotate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("mcp.admin.client.rotateSecret")}</DialogTitle>
            <DialogDescription>{t("mcp.admin.client.rotateConfirm")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRotate(false)}>
              {t("common.cancel", "Cancel")}
            </Button>
            <Button variant="destructive" onClick={handleRotate} disabled={rotating}>
              {rotating
                ? t("common.processing", "Processing...")
                : t("mcp.admin.client.rotateSecret")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New secret display dialog */}
      <Dialog
        open={rotateResult !== null}
        onOpenChange={(open) => {
          if (!open) setRotateResult(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("mcp.admin.client.rotateSecret")}</DialogTitle>
            <DialogDescription>{t("mcp.admin.client.secretWarning")}</DialogDescription>
          </DialogHeader>
          {rotateResult && (
            <div className="space-y-3 py-2">
              <div className="space-y-1">
                <Label>{t("mcp.admin.client.clientId")}</Label>
                <code className="block text-sm bg-muted p-2 rounded break-all">
                  {rotateResult.clientId}
                </code>
              </div>
              <div className="space-y-1">
                <Label>Secret</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-sm bg-muted p-2 rounded break-all font-mono">
                    {rotateResult.clientSecret}
                  </code>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => copySecret(rotateResult.clientSecret)}
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
            <Button onClick={() => setRotateResult(null)}>{t("common.done", "Done")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default McpClientDetail;
