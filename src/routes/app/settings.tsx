import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Loader2, UserPlus, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorState, PageHeader } from "@/components/empty-state";
import { aidwar } from "@/integrations/aidwar/client";
import { logActivity } from "@/lib/activity";
import { useOrg, type OrgRole } from "@/lib/org-context";
import { WhatsAppTab } from "@/components/whatsapp-settings";

export const Route = createFileRoute("/app/settings")({
  head: () => ({
    meta: [
      { title: "Settings — AiDwar" },
      { name: "description", content: "Manage your AiDwar workspace, team members and connections." },
      { property: "og:title", content: "Settings — AiDwar" },
      { property: "og:description", content: "Manage your AiDwar workspace, team members and connections." },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const { active, loading, error } = useOrg();

  return (
    <>
      <PageHeader
        title="Settings"
        description="Workspace details, your team, and the connections that power your messaging."
      />
      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-10 w-72 rounded-xl" />
          <Skeleton className="h-64 w-full rounded-2xl" />
        </div>
      ) : error ? (
        <ErrorState message={error} />
      ) : !active ? (
        <ErrorState message="We couldn't find your workspace. Please refresh the page." />
      ) : (
        <Tabs defaultValue="general" className="max-w-3xl">
          <TabsList>
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="team">Team</TabsTrigger>
            <TabsTrigger value="whatsapp">WhatsApp</TabsTrigger>
          </TabsList>
          <TabsContent value="general" className="mt-6">
            <GeneralTab />
          </TabsContent>
          <TabsContent value="team" className="mt-6">
            <TeamTab />
          </TabsContent>
          <TabsContent value="whatsapp" className="mt-6">
            <WhatsAppTab />
          </TabsContent>
        </Tabs>
      )}
    </>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm sm:p-8">{children}</div>;
}

function GeneralTab() {
  const { active, canManage, reload } = useOrg();
  const [name, setName] = useState(active?.organization.name ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(active?.organization.name ?? "");
  }, [active?.organization.name]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!active) return;
    if (name.trim().length < 2) {
      toast.error("Workspace name must be at least 2 characters.");
      return;
    }
    setSaving(true);
    const { error } = await aidwar
      .from("organizations")
      .update({ name: name.trim() })
      .eq("id", active.organization.id);
    setSaving(false);
    if (error) {
      toast.error("We couldn't save your changes. Please try again.");
      return;
    }
    await logActivity("organization.updated", active.organization.id, { field: "name" });
    toast.success("Workspace updated");
    await reload();
  }

  return (
    <Card>
      <h2 className="text-base font-semibold text-foreground">Workspace</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {canManage
          ? "Change how your workspace appears across AiDwar."
          : "Only owners and admins can change workspace details."}
      </p>
      <form onSubmit={save} className="mt-6 max-w-md space-y-4">
        <div className="space-y-2">
          <Label htmlFor="org_name">Organization name</Label>
          <Input
            id="org_name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!canManage || saving}
          />
        </div>
        {canManage ? (
          <Button type="submit" className="rounded-full" disabled={saving}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save changes
          </Button>
        ) : null}
      </form>
    </Card>
  );
}

type MemberRow = { id: string; user_id: string; role: OrgRole; created_at: string };
type Member = MemberRow & { full_name: string | null; email: string | null };
type Invite = { id: string; email: string; role: OrgRole; token: string; expires_at: string };

function TeamTab() {
  const { active, canManage, profile } = useOrg();
  const orgId = active?.organization.id;
  const [members, setMembers] = useState<Member[] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgRole>("agent");
  const [inviting, setInviting] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orgId) return;
    setError(null);
    const { data: rows, error: memberErr } = await aidwar
      .from("organization_members")
      .select("id, user_id, role, created_at")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: true });

    if (memberErr) {
      setError("We couldn't load your team. Please refresh.");
      setMembers([]);
      return;
    }

    const list = (rows ?? []) as MemberRow[];
    const ids = list.map((r) => r.user_id);
    const { data: profs } = ids.length
      ? await aidwar.from("profiles").select("id, full_name, email").in("id", ids)
      : { data: [] as { id: string; full_name: string | null; email: string | null }[] };

    const byId = new Map((profs ?? []).map((p) => [p.id, p]));
    setMembers(
      list.map((m) => ({
        ...m,
        full_name: byId.get(m.user_id)?.full_name ?? null,
        email: byId.get(m.user_id)?.email ?? null,
      })),
    );

    if (canManage) {
      const { data: inv } = await aidwar
        .from("invitations")
        .select("id, email, role, token, expires_at")
        .eq("organization_id", orgId)
        .is("accepted_at", null)
        .order("created_at", { ascending: false });
      setInvites((inv ?? []) as Invite[]);
    }
  }, [orgId, canManage]);

  useEffect(() => {
    void load();
  }, [load]);

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
      .insert({ organization_id: orgId, email: email.trim().toLowerCase(), role });
    setInviting(false);
    if (err) {
      toast.error("We couldn't create that invite. Please try again.");
      return;
    }
    setEmail("");
    await logActivity("member.invited", orgId, { role });
    toast.success("Invite created — copy the link and share it.");
    await load();
  }

  async function revoke(id: string) {
    const { error: err } = await aidwar.from("invitations").delete().eq("id", id);
    if (err) {
      toast.error("We couldn't revoke that invite.");
      return;
    }
    await load();
  }

  function copyLink(token: string) {
    const url = `${window.location.origin}/join/${token}`;
    void navigator.clipboard.writeText(url);
    setCopied(token);
    toast.success("Invite link copied");
    setTimeout(() => setCopied(null), 2000);
  }

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex items-center gap-3">
          <Users className="h-5 w-5 text-primary" />
          <h2 className="text-base font-semibold text-foreground">Team members</h2>
        </div>

        {error ? (
          <div className="mt-6">
            <ErrorState message={error} />
          </div>
        ) : members === null ? (
          <div className="mt-6 space-y-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14 w-full rounded-xl" />
            ))}
          </div>
        ) : members.length === 0 ? (
          <p className="mt-6 text-sm text-muted-foreground">No members yet.</p>
        ) : (
          <ul className="mt-6 divide-y divide-border/70">
            {members.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {m.full_name || m.email || "Teammate"}
                    {m.user_id === profile?.id ? (
                      <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                    ) : null}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{m.email ?? "—"}</p>
                </div>
                <Badge variant="secondary" className="capitalize">
                  {m.role}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canManage ? (
        <Card>
          <div className="flex items-center gap-3">
            <UserPlus className="h-5 w-5 text-primary" />
            <h2 className="text-base font-semibold text-foreground">Invite a teammate</h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Create an invite link and share it. It works for 7 days and can be used once.
          </p>
          <form onSubmit={invite} className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@company.com"
              className="sm:flex-1"
            />
            <Select value={role} onValueChange={(v) => setRole(v as OrgRole)}>
              <SelectTrigger className="sm:w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="agent">Agent</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="owner">Owner</SelectItem>
              </SelectContent>
            </Select>
            <Button type="submit" className="rounded-full" disabled={inviting}>
              {inviting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Invite
            </Button>
          </form>

          {invites.length > 0 ? (
            <ul className="mt-6 divide-y divide-border/70">
              {invites.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">{i.email}</p>
                    <p className="text-xs capitalize text-muted-foreground">
                      {i.role} · expires {new Date(i.expires_at).toLocaleDateString("en-IN")}
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
                    <Button variant="ghost" size="sm" className="rounded-full" onClick={() => revoke(i.id)}>
                      Revoke
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}

