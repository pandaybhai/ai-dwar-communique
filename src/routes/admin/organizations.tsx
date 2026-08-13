import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Building2, Loader2, PauseCircle, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorState, PageHeader, PageSkeleton } from "@/components/empty-state";
import { aidwar } from "@/integrations/aidwar/client";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/admin/organizations")({
  head: () => ({
    meta: [
      { title: "Organizations — AiDwar Admin" },
      { name: "description", content: "Every workspace on AiDwar with member counts and status controls." },
      { property: "og:title", content: "Organizations — AiDwar Admin" },
      { property: "og:description", content: "Every workspace on AiDwar with member counts and status controls." },
    ],
  }),
  component: AdminOrganizations,
});

type Org = { id: string; name: string; slug: string; status: string; created_at: string; members: number };

function AdminOrganizations() {
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const [{ data: rows, error: err }, { data: members }] = await Promise.all([
      aidwar.from("organizations").select("id, name, slug, status, created_at").order("created_at", { ascending: false }),
      aidwar.from("organization_members").select("organization_id"),
    ]);
    if (err) {
      setError("We couldn't load organizations. Please refresh.");
      setOrgs([]);
      return;
    }
    const counts = new Map<string, number>();
    for (const m of (members ?? []) as { organization_id: string }[]) {
      counts.set(m.organization_id, (counts.get(m.organization_id) ?? 0) + 1);
    }
    setOrgs(
      ((rows ?? []) as Omit<Org, "members">[]).map((o) => ({ ...o, members: counts.get(o.id) ?? 0 })),
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleStatus(org: Org) {
    setBusy(org.id);
    const next = org.status === "active" ? "suspended" : "active";
    const { error: err } = await aidwar.from("organizations").update({ status: next }).eq("id", org.id);
    setBusy(null);
    if (err) {
      setError("We couldn't update that organization.");
      return;
    }
    await load();
  }

  if (!orgs) return <PageSkeleton />;

  const filtered = orgs.filter((o) => o.name.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <>
      <PageHeader title="Organizations" description="Every workspace on AiDwar, with members, status and controls." />
      {error ? <div className="mb-6"><ErrorState message={error} /></div> : null}

      {orgs.length === 0 ? (
        <EmptyState icon={Building2} title="No organizations yet" description="Workspaces will appear here as soon as customers sign up and create one." />
      ) : (
        <div className="space-y-4">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search organizations…"
            className="max-w-sm"
          />
          <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Organization</th>
                    <th className="px-4 py-3 font-semibold">Members</th>
                    <th className="px-4 py-3 font-semibold">Created</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/70">
                  {filtered.map((o) => (
                    <tr key={o.id} className="transition-colors duration-200 hover:bg-muted/30">
                      <td className="px-4 py-3">
                        <span className="block font-medium text-foreground">{o.name}</span>
                        <span className="block text-xs text-muted-foreground">/{o.slug}</span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{o.members}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {new Date(o.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            "inline-flex rounded-full px-2.5 py-1 text-xs font-semibold capitalize",
                            o.status === "active"
                              ? "bg-primary/10 text-primary"
                              : "bg-destructive/10 text-destructive",
                          )}
                        >
                          {o.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          className="rounded-full"
                          disabled={busy === o.id}
                          onClick={() => toggleStatus(o)}
                        >
                          {busy === o.id ? (
                            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                          ) : o.status === "active" ? (
                            <PauseCircle className="mr-2 h-3.5 w-3.5" />
                          ) : (
                            <PlayCircle className="mr-2 h-3.5 w-3.5" />
                          )}
                          {o.status === "active" ? "Suspend" : "Activate"}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {filtered.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">No organizations match “{query}”.</p>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}
