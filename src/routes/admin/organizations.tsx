import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Building2, Loader2, PauseCircle, PlayCircle, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, ErrorState, PageHeader } from "@/components/empty-state";
import { NoResults, Pagination, TableSkeleton } from "@/components/data-pagination";
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

const PAGE_SIZE = 25;

type Org = { id: string; name: string; slug: string; status: string; created_at: string; members: number };

function SelectBox({
  id,
  value,
  onChange,
  children,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-ring"
    >
      {children}
    </select>
  );
}

function AdminOrganizations() {
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("created_desc");
  const [page, setPage] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(query.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(async () => {
    setError(null);
    setOrgs(null);

    let q = aidwar
      .from("organizations")
      .select("id, name, slug, status, created_at", { count: "exact" })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

    if (search) q = q.or(`name.ilike.%${search}%,slug.ilike.%${search}%`);
    if (status) q = q.eq("status", status);
    q = q.order("created_at", { ascending: sort === "created_asc" });

    const { data, error: err, count } = await q;
    if (err) {
      setError("We couldn't load organizations. Please refresh.");
      setOrgs([]);
      setTotal(0);
      return;
    }

    const rows = (data ?? []) as Omit<Org, "members">[];
    const counts = new Map<string, number>();
    if (rows.length > 0) {
      const { data: members } = await aidwar
        .from("organization_members")
        .select("organization_id")
        .in("organization_id", rows.map((r) => r.id));
      for (const m of (members ?? []) as { organization_id: string }[]) {
        counts.set(m.organization_id, (counts.get(m.organization_id) ?? 0) + 1);
      }
    }

    let withCounts = rows.map((o) => ({ ...o, members: counts.get(o.id) ?? 0 }));
    if (sort === "members_desc") withCounts = [...withCounts].sort((a, b) => b.members - a.members);
    if (sort === "members_asc") withCounts = [...withCounts].sort((a, b) => a.members - b.members);

    setOrgs(withCounts);
    setTotal(count ?? withCounts.length);
  }, [page, search, status, sort]);

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

  const filtersActive = Boolean(search || status);

  return (
    <>
      <PageHeader title="Organizations" description="Every workspace on AiDwar, with members, status and controls." />
      {error ? <div className="mb-6"><ErrorState message={error} /></div> : null}

      <div className="mb-6 grid gap-4 rounded-2xl border border-border/70 bg-card p-5 shadow-sm sm:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="org_q">Search</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="org_q"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name or slug…"
              className="pl-9"
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="org_status">Status</Label>
          <SelectBox id="org_status" value={status} onChange={(v) => { setStatus(v); setPage(0); }}>
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
          </SelectBox>
        </div>
        <div className="space-y-2">
          <Label htmlFor="org_sort">Sort</Label>
          <SelectBox id="org_sort" value={sort} onChange={(v) => { setSort(v); setPage(0); }}>
            <option value="created_desc">Newest first</option>
            <option value="created_asc">Oldest first</option>
            <option value="members_desc">Most members</option>
            <option value="members_asc">Fewest members</option>
          </SelectBox>
        </div>
      </div>

      {!orgs ? (
        <TableSkeleton />
      ) : total === 0 && !filtersActive ? (
        <EmptyState
          icon={Building2}
          title="No organizations yet"
          description="Workspaces will appear here as soon as customers sign up and create one."
        />
      ) : (
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
                {orgs.map((o) => (
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
          {orgs.length === 0 ? (
            <NoResults message="No organizations match your filters." />
          ) : (
            <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
          )}
        </div>
      )}
    </>
  );
}
