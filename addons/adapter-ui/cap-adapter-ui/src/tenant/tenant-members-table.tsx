/**
 * TenantMembersTable — list members of the current tenant with role
 * management, removal, and an "Invite member" Dialog.
 *
 * Mirrors the controlled-form pattern used by the branding/config tabs:
 * data + mutations are sourced from `useTenantSelfService()` and passed
 * in via props so the table itself stays mock/transport agnostic.
 */

import {
  Avatar,
  AvatarFallback,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@linchkit/ui-kit/components";
import { Trash2Icon, UserPlusIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { INVITABLE_ROLES, isValidEmail } from "./tenant-helpers";
import type {
  InviteMemberInput,
  TenantMember,
  TenantMemberRole,
} from "./tenant-self-service-types";

export interface TenantMembersTableProps {
  members: readonly TenantMember[];
  onInvite: (input: InviteMemberInput) => Promise<void> | void;
  onRemove: (memberId: string) => Promise<void> | void;
  onChangeRole?: (memberId: string, role: TenantMemberRole) => Promise<void> | void;
  disabled?: boolean;
}

const ALL_ROLES: readonly TenantMemberRole[] = ["owner", "admin", "member", "viewer"] as const;

/** Build a 1-2 char initial from a display name or email. */
function getInitials(member: TenantMember): string {
  const source = member.displayName?.trim() || member.email;
  const parts = source.split(/\s+/).filter(Boolean);
  const first = parts[0];
  const second = parts[1];
  if (first && second) {
    return (first.charAt(0) + second.charAt(0)).toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

/** Format an ISO timestamp as the user's locale date; falls back to "—". */
function formatLastActive(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString();
}

export function TenantMembersTable({
  members,
  onInvite,
  onRemove,
  onChangeRole,
  disabled,
}: TenantMembersTableProps) {
  const { t } = useTranslation();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<TenantMemberRole>("member");
  const [submitting, setSubmitting] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const emailValid = isValidEmail(inviteEmail);
  const canInvite = !disabled && !submitting && emailValid;

  const resetInviteForm = () => {
    setInviteEmail("");
    setInviteRole("member");
  };

  const handleInvite = async () => {
    if (!canInvite) return;
    setSubmitting(true);
    try {
      await onInvite({ email: inviteEmail.trim(), role: inviteRole });
      resetInviteForm();
      setDialogOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async (memberId: string) => {
    if (disabled) return;
    setRemovingId(memberId);
    try {
      await onRemove(memberId);
    } finally {
      setRemovingId(null);
    }
  };

  const handleRoleChange = async (memberId: string, role: TenantMemberRole) => {
    if (!onChangeRole || disabled) return;
    await onChangeRole(memberId, role);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">{t("tenant.members.title", "Members")}</h2>
          <p className="text-sm text-muted-foreground">
            {t(
              "tenant.members.description",
              "Manage who has access to this tenant and what they can do.",
            )}
          </p>
        </div>
        <Dialog
          open={dialogOpen}
          onOpenChange={(next) => {
            setDialogOpen(next);
            if (!next) resetInviteForm();
          }}
        >
          <Button type="button" onClick={() => setDialogOpen(true)} disabled={disabled}>
            <UserPlusIcon className="mr-2 h-4 w-4" />
            {t("tenant.members.invite", "Invite member")}
          </Button>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("tenant.members.inviteTitle", "Invite a new member")}</DialogTitle>
              <DialogDescription>
                {t(
                  "tenant.members.inviteDescription",
                  "Send an invitation by email. The invitee will receive a link to join this tenant.",
                )}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="tenant-invite-email">{t("tenant.members.email", "Email")}</Label>
                <Input
                  id="tenant-invite-email"
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="name@example.com"
                  autoComplete="off"
                />
                {inviteEmail.length > 0 && !emailValid && (
                  <p className="text-xs text-destructive">
                    {t("tenant.members.invalidEmail", "Enter a valid email address.")}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="tenant-invite-role">{t("tenant.members.role", "Role")}</Label>
                <Select
                  value={inviteRole}
                  onValueChange={(v) => setInviteRole(v as TenantMemberRole)}
                >
                  <SelectTrigger id="tenant-invite-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INVITABLE_ROLES.map((role) => (
                      <SelectItem key={role} value={role}>
                        {role}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialogOpen(false)}
                disabled={submitting}
              >
                {t("tenant.members.cancel", "Cancel")}
              </Button>
              <Button type="button" onClick={handleInvite} disabled={!canInvite}>
                {submitting
                  ? t("tenant.members.sending", "Sending...")
                  : t("tenant.members.send", "Send invite")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12" />
              <TableHead>{t("tenant.members.name", "Name")}</TableHead>
              <TableHead>{t("tenant.members.email", "Email")}</TableHead>
              <TableHead className="w-44">{t("tenant.members.role", "Role")}</TableHead>
              <TableHead>{t("tenant.members.lastActive", "Last active")}</TableHead>
              <TableHead className="w-16 text-right">
                {t("tenant.members.actions", "Actions")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                  {t("tenant.members.empty", "No members yet. Invite someone to get started.")}
                </TableCell>
              </TableRow>
            )}
            {members.map((member) => {
              const isOwner = member.role === "owner";
              const removing = removingId === member.id;
              return (
                <TableRow key={member.id}>
                  <TableCell>
                    <Avatar className="h-8 w-8">
                      <AvatarFallback>{getInitials(member)}</AvatarFallback>
                    </Avatar>
                  </TableCell>
                  <TableCell className="font-medium">
                    {member.displayName || member.email.split("@")[0]}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{member.email}</TableCell>
                  <TableCell>
                    <Select
                      value={member.role}
                      onValueChange={(v) => handleRoleChange(member.id, v as TenantMemberRole)}
                      disabled={disabled || !onChangeRole || isOwner}
                    >
                      <SelectTrigger className="h-8 w-36">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ALL_ROLES.map((role) => (
                          <SelectItem key={role} value={role}>
                            {role}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatLastActive(member.joinedAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleRemove(member.id)}
                      disabled={disabled || removing || isOwner}
                      aria-label={t("tenant.members.remove", "Remove member")}
                    >
                      <Trash2Icon className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
