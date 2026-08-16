import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, Loader2, ShieldCheck, SlidersHorizontal, Trash2, UserPlus, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ErrorState } from "@/components/empty-state";
import { aidwar } from "@/integrations/aidwar/client";
import { logActivity } from "@/lib/activity";
import { useOrg } from "@/lib/org-context";
import { usePermissions } from "@/hooks/use-permissions";
import {
  CATEGORY_LABELS,
  PERMISSION_CATEGORIES,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  ROLE_RANK,
  databaseMessage,
  type OrgRole,
  type PermissionCategory,
  type PermissionRow,
} from "@/lib/permissions";

type MemberRow = { id: string; user_id: string; role: OrgRole; created_at: string };
type Member = MemberRow & {
  full_name: string | null;
  email: string | null;
  last_active: string | null;
  override_count: number;
};
type Invite = { id: string; email: string; role: OrgRole; token: string; expires_at: string };

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm sm:p-8">{children}</div>;
}

function Hint({ show, reason, children }: { show: boolean; reason: string; children: React.ReactNode }) {
  if (!show) return <>{children}</>;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="inline-flex">
            <span className="pointer-events-none block opacity-50">{children}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs leading-relaxed">{reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function TeamSettings() {
  const { active, profile, isSuperAdmin } = useOrg();
  const { can, reload: reloadPermissions } = usePermissions();
  const orgId = active?.organization.id ?? null;
  const canManageTeam = can("team.manage");

  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [catalog, setCatalog] = useState<PermissionRow[]>([]);
  const [presets, setPresets] = useState<Record<string, Set<string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Member | null>(null);

  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<OrgRole>("agent");
  const [inviting, setInviting] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [busyMember, setBusyMember] = useState<string | null>(null);

  const myRank = isSuperAdmin ? 99 : ROLE_RANK[(active?.role as OrgRole) ?? "agent"];

  const assignableRoles = useMemo(
    () => (Object.keys(ROLE_RANK) as OrgRole[]).filter((r) => ROLE_RANK[r] < myRank).sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a]),
    [myRank],
  );

  const loadCatalog = useCallback(async () => {
    const [{ data: perms }, { data: rolePerms }] = await Promise.all([
      aidwar.from("permissions").select("key, name, description, category, min_role"),
      aidwar.from("role_permissions").select("role, permission_key"),
    ]);
    setCatalog((perms ?? []) as PermissionRow[]);
    const map: Record<string, Set<string>> = {};
    for (const row of (rolePerms ?? []) as { role: string; permission_key: string }[]) {
      (map[row.role] ??= new Set()).add(row.permission_key);
    }
    setPresets(map);
  }, []);

  const load = useCallback(async () => {
    if (!orgId) return;
    setError(null);
    const { data: rows, error: memberErr } = await aidwar
      .from("organization_members")
      .select("id, user_id, role, created_at")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: true });

    if (memberErr) {
      setError(databaseMessage(memberErr, "We couldn't load your team. Please refresh."));
      setMembers([]);
      return;
    }

    const list = (rows ?? []) as MemberRow[];
    const ids = list.map((r) => r.user_id);

    const [{ data: profs }, { data: overrides }, { data: activity }] = await Promise.all([
      ids.length
        ? aidwar.from("profiles").select("id, full_name, email").in("id", ids)
        : Promise.resolve({ data: [] as { id: string; full_name: string | null; email: string | null }[] }),
      aidwar
        .from("member_permissions")
        .select("user_id, permission_key, granted")
        .eq("organization_id", orgId),
      aidwar
        .from("activity_log")
        .select("user_id, created_at")
        .eq("organization_id", orgId)
        .order("created_at", { ascending: false })
        .limit(400),
    ]);

    const byId = new Map(((profs ?? []) as { id: string; full_name: string | null; email: string | null }[]).map((p) => [p.id, p]));
    const overrideCount = new Map<string, number>();
    for (const o of (overrides ?? []) as { user_id: string }[]) {
      overrideCount.set(o.user_id, (overrideCount.get(o.user_id) ?? 0) + 1);
    }
    const lastActive = new Map<string, string>();
    for (const a of (activity ?? []) as { user_id: string | null; created_at: string }[]) {
      if (a.user_id && !lastActive.has(a.user_id)) lastActive.set(a.user_id, a.created_at);
    }

    setMembers(
      list.map((m) => ({
        ...m,
        full_name: byId.get(m.user_id)?.full_name ?? null,
        email: byId.get(m.user_id)?.email ?? null,
        last_active: lastActive.get(m.user_id) ?? null,
        override_count: overrideCount.get(m.user_id) ?? 0,
      })),
    );

    if (canManageTeam) {
      const { data: inv } = await aidwar
        .from("invitations")
        .select("id, email, role, token, expires_at")
        .eq("organization_id", orgId)
        .is("accepted_at", null)
        .order("created_at", { ascending: false });
      setInvites((inv ?? []) as Invite[]);
    } else {
      setInvites([]);
    }
  }, [orgId, canManageTeam]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    void load();
  }, [load]);

  async function changeRole(member: Member, role: OrgRole) {
    if (!orgId) return;
    setBusyMember(member.id);
    const { error: err } = await aidwar
      .from("organization_members")
      .update({ role })
      .eq("id", member.id);
    setBusyMember(null);
    if (err) {
      toast.error(databaseMessage(err, "We couldn't change that role."));
      return;
    }
    await logActivity("member.role_changed", orgId, {
      member_user_id: member.user_id,
      from: member.role,
      to: role,
    });
    toast.success(`${member.full_name || member.email || "Member"} is now ${ROLE_LABELS[role]}.`);
    await load();
    if (member.user_id === profile?.id) await reloadPermissions();
  }

  async function removeMember(member: Member) {
    if (!orgId) return;
    setBusyMember(member.id);
    const { error: err } = await aidwar.from("organization_members").delete().eq("id", member.id);
    setBusyMember(null);
    if (err) {
      toast.error(databaseMessage(err, "We couldn't remove that member."));
      return;
    }
    await logActivity("member.removed", orgId, { member_user_id: member.user_id, role: member.role });
    toast.success("Member removed");
    await load();
  }

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    if (!orgId) return;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      toast.error("Please enter a valid email address.");
      return;
    }
    setInviting(true);
    const { error: err } = await aidwar
      .from("invitations")
      .insert({ organization_id: orgId, email: email.trim().toLowerCase(), role: inviteRole });
    setInviting(false);
    if (err) {
      toast.error(databaseMessage(err, "We couldn't create that invite."));
      return;
    }
    setEmail("");
    await logActivity("member.invited", orgId, { role: inviteRole });
    toast.success("Invite created — copy the link and share it.");
    await load();
  }

  async function revoke(id: string) {
    const { error: err } = await aidwar.from("invitations").delete().eq("id", id);
    if (err) {
      toast.error(databaseMessage(err, "We couldn't revoke that invite."));
      return;
    }
    await load();
  }

  function copyLink(token: string) {
    void navigator.clipboard.writeText(`${window.location.origin}/join/${token}`);
    setCopied(token);
    toast.success("Invite link copied");
    setTimeout(() => setCopied(null), 2000);
  }

  if (!orgId) return <ErrorState message="We couldn't find your workspace. Please refresh the page." />;
  if (error) return <ErrorState message={error} />;

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex items-center gap-3">
          <Users className="h-5 w-5 text-primary" />
          <h2 className="text-base font-semibold text-foreground">Team members</h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Roles are presets. Anything you change per person sits on top of their role.
        </p>

        {members === null ? (
          <div className="mt-6 space-y-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-xl" />
            ))}
          </div>
        ) : members.length === 0 ? (
          <p className="mt-6 text-sm text-muted-foreground">No members yet.</p>
        ) : (
          <ul className="mt-6 divide-y divide-border/70">
            {members.map((m) => {
              const isSelf = m.user_id === profile?.id;
              const canEditThis = canManageTeam && !isSelf && (isSuperAdmin || ROLE_RANK[m.role] < myRank);
              const reason = isSelf
                ? "You can't change your own role or remove yourself."
                : !canManageTeam
                  ? "You need the \"Manage team\" permission."
                  : "You can only manage members whose role is below your own.";
              return (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 truncate text-sm font-medium text-foreground">
                      {m.full_name || m.email || "Teammate"}
                      {isSelf ? <span className="text-xs text-muted-foreground">(you)</span> : null}
                      {m.override_count > 0 ? (
                        <Badge variant="outline" className="gap-1 text-[11px]">
                          <ShieldCheck className="h-3 w-3" />
                          {m.override_count} custom
                        </Badge>
                      ) : null}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {m.email ?? "—"} · last active{" "}
                      {m.last_active ? new Date(m.last_active).toLocaleDateString("en-IN") : "not yet"}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    {canEditThis && assignableRoles.length > 0 ? (
                      <Select
                        value={m.role}
                        onValueChange={(v) => void changeRole(m, v as OrgRole)}
                        disabled={busyMember === m.id}
                      >
                        <SelectTrigger className="w-36 rounded-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(assignableRoles.includes(m.role) ? assignableRoles : [m.role, ...assignableRoles]).map(
                            (r) => (
                              <SelectItem key={r} value={r}>
                                {ROLE_LABELS[r]}
                              </SelectItem>
                            ),
                          )}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Hint show reason={reason}>
                        <Badge variant="secondary">{ROLE_LABELS[m.role]}</Badge>
                      </Hint>
                    )}

                    <Hint show={!canManageTeam} reason={'You need the "Manage team" permission.'}>
                      <Button
                        variant="outline"
                        size="sm"
                        className="rounded-full"
                        onClick={() => setEditing(m)}
                        disabled={!canManageTeam}
                      >
                        <SlidersHorizontal className="mr-2 h-3.5 w-3.5" />
                        Permissions
                      </Button>
                    </Hint>

                    {canEditThis ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="rounded-full text-muted-foreground"
                        disabled={busyMember === m.id}
                        onClick={() => void removeMember(m)}
                      >
                        {busyMember === m.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <div className="flex items-center gap-3">
          <UserPlus className="h-5 w-5 text-primary" />
          <h2 className="text-base font-semibold text-foreground">Invite a teammate</h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {canManageTeam
            ? `You can invite people as ${assignableRoles.map((r) => ROLE_LABELS[r]).join(", ") || "no role"} — never at or above your own role.`
            : "You need the \"Manage team\" permission to invite people."}
        </p>
        {canManageTeam && assignableRoles.length > 0 ? (
          <>
            <form onSubmit={invite} className="mt-6 flex flex-col gap-3 sm:flex-row">
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="teammate@company.com"
                className="sm:flex-1"
              />
              <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as OrgRole)}>
                <SelectTrigger className="sm:w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {assignableRoles.map((r) => (
                    <SelectItem key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="submit" className="rounded-full" disabled={inviting}>
                {inviting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Invite
              </Button>
            </form>
            <p className="mt-2 text-xs text-muted-foreground">{ROLE_DESCRIPTIONS[inviteRole]}</p>

            {invites.length > 0 ? (
              <ul className="mt-6 divide-y divide-border/70">
                {invites.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{i.email}</p>
                      <p className="text-xs text-muted-foreground">
                        {ROLE_LABELS[i.role] ?? i.role} · expires{" "}
                        {new Date(i.expires_at).toLocaleDateString("en-IN")}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" className="rounded-full" onClick={() => copyLink(i.token)}>
                        {copied === i.token ? (
                          <Check className="mr-2 h-3.5 w-3.5" />
                        ) : (
                          <Copy className="mr-2 h-3.5 w-3.5" />
                        )}
                        Copy link
                      </Button>
                      <Button variant="ghost" size="sm" className="rounded-full" onClick={() => void revoke(i.id)}>
                        Revoke
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}
      </Card>

      <PermissionEditor
        member={editing}
        organizationId={orgId}
        catalog={catalog}
        presets={presets}
        open={editing !== null}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          await load();
          if (editing?.user_id === profile?.id) await reloadPermissions();
        }}
      />
    </div>
  );
}

function PermissionEditor({
  member,
  organizationId,
  catalog,
  presets,
  open,
  onClose,
  onSaved,
}: {
  member: Member | null;
  organizationId: string;
  catalog: PermissionRow[];
  presets: Record<string, Set<string>>;
  open: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { can } = usePermissions();
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!member) return;
    setLoading(true);
    const { data } = await aidwar
      .from("member_permissions")
      .select("permission_key, granted")
      .eq("organization_id", organizationId)
      .eq("user_id", member.user_id);
    const map: Record<string, boolean> = {};
    for (const row of (data ?? []) as { permission_key: string; granted: boolean }[]) {
      map[row.permission_key] = row.granted;
    }
    setOverrides(map);
    setLoading(false);
  }, [member, organizationId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  if (!member) return null;

  const targetIsOwner = member.role === "owner";
  const preset = presets[member.role] ?? new Set<string>();

  async function setOverride(key: string, granted: boolean) {
    if (!member) return;
    setBusy(key);
    const { error } = await aidwar.from("member_permissions").upsert(
      { organization_id: organizationId, user_id: member.user_id, permission_key: key, granted },
      { onConflict: "organization_id,user_id,permission_key" },
    );
    setBusy(null);
    if (error) {
      toast.error(databaseMessage(error, "We couldn't save that permission."));
      return;
    }
    await logActivity("member.permission_overridden", organizationId, {
      member_user_id: member.user_id,
      permission: key,
      granted,
    });
    setOverrides((prev) => ({ ...prev, [key]: granted }));
    await onSaved();
  }

  async function clearOverride(key: string) {
    if (!member) return;
    setBusy(key);
    const { error } = await aidwar
      .from("member_permissions")
      .delete()
      .eq("organization_id", organizationId)
      .eq("user_id", member.user_id)
      .eq("permission_key", key);
    setBusy(null);
    if (error) {
      toast.error(databaseMessage(error, "We couldn't reset that permission."));
      return;
    }
    await logActivity("member.permission_reset", organizationId, {
      member_user_id: member.user_id,
      permission: key,
    });
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    await onSaved();
  }

  return (
    <Sheet open={open} onOpenChange={(v) => (v ? null : onClose())}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{member.full_name || member.email || "Teammate"}</SheetTitle>
          <SheetDescription>
            {ROLE_LABELS[member.role]} preset. Toggling a permission creates an override; reset returns it to the
            role default.
          </SheetDescription>
        </SheetHeader>

        {targetIsOwner ? (
          <p className="mt-6 rounded-xl border border-border/70 bg-muted/40 p-4 text-sm text-muted-foreground">
            Owners always hold every permission — that can't be overridden, so nobody can lock an owner out of their
            own workspace.
          </p>
        ) : null}

        <div className="mt-6 space-y-6 pb-10">
          {loading
            ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-28 w-full rounded-xl" />)
            : PERMISSION_CATEGORIES.map((category) => {
                const rows = catalog.filter((p) => p.category === (category as PermissionCategory));
                if (rows.length === 0) return null;
                return (
                  <div key={category}>
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {CATEGORY_LABELS[category]}
                    </h3>
                    <Separator className="my-3" />
                    <ul className="space-y-3">
                      {rows.map((p) => {
                        const hasOverride = p.key in overrides;
                        const effective = targetIsOwner
                          ? true
                          : hasOverride
                            ? overrides[p.key]
                            : preset.has(p.key);
                        const iHoldIt = can(p.key);
                        const locked = targetIsOwner || !iHoldIt;
                        const lockReason = targetIsOwner
                          ? "Owners always hold every permission."
                          : `You don't hold "${p.name}" yourself, so you can't grant or revoke it.`;
                        return (
                          <li key={p.key} className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-foreground">{p.name}</p>
                              <p className="text-xs text-muted-foreground">{p.description}</p>
                              <p className="mt-1 text-[11px] text-muted-foreground">
                                {targetIsOwner
                                  ? "Always on"
                                  : hasOverride
                                    ? `Overridden — ${effective ? "granted" : "revoked"} for this person`
                                    : effective
                                      ? "Inherited from role — on"
                                      : "Inherited from role — off"}
                                {hasOverride && !targetIsOwner && iHoldIt ? (
                                  <button
                                    type="button"
                                    className="ml-2 underline underline-offset-2 transition-colors hover:text-foreground"
                                    onClick={() => void clearOverride(p.key)}
                                  >
                                    Reset to role default
                                  </button>
                                ) : null}
                              </p>
                            </div>
                            <Hint show={locked} reason={lockReason}>
                              <Switch
                                checked={Boolean(effective)}
                                disabled={locked || busy === p.key}
                                onCheckedChange={(v) => void setOverride(p.key, v)}
                              />
                            </Hint>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
