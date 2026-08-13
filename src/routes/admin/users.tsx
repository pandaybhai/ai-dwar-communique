import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Search, ShieldCheck, Users } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { EmptyState, ErrorState, PageHeader } from "@/components/empty-state";
import { NoResults, Pagination, TableSkeleton } from "@/components/data-pagination";
import { aidwar } from "@/integrations/aidwar/client";

export const Route = createFileRoute("/admin/users")({
  head: () => ({
    meta: [
      { title: "Users — AiDwar Admin" },
      { name: "description", content: "All AiDwar users and the workspaces they belong to." },
      { property: "og:title", content: "Users — AiDwar Admin" },
      { property: "og:description", content: "All AiDwar users and the workspaces they belong to." },
    ],
  }),
  component: AdminUsers,
});

const PAGE_SIZE = 25;

type Row = {
  id: string;
  full_name: string | null;
  email: string | null;
  is_super_admin: boolean | null;
  created_at: string | null;
  memberships: { org: string; role: string }[];
};

function AdminUsers() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [superOnly, setSuperOnly] = useState(false);
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
    setRows(null);

    let q = aidwar
      .from("profiles")
      .select("id, full_name, email, is_super_admin, created_at", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

    if (search) q = q.or(`full_name.ilike.%${search}%,email.ilike.%${search}%`);
    if (superOnly) q = q.eq("is_super_admin", true);

    const { data: profiles, error: err, count } = await q;
    if (err) {
      setError("We couldn't load users. Please refresh.");
      setRows([]);
      setTotal(0);
      return;
    }

    const list = (profiles ?? []) as Omit<Row, "memberships">[];
    const byUser = new Map<string, { org: string; role: string }[]>();

    if (list.length > 0) {
      const { data: members } = await aidwar
        .from("organization_members")
        .select("user_id, organization_id, role")
        .in("user_id", list.map((p) => p.id));
      const memberRows = (members ?? []) as { user_id: string; organization_id: string; role: string }[];
      const orgIds = Array.from(new Set(memberRows.map((m) => m.organization_id)));
      const orgName = new Map<string, string>();
      if (orgIds.length > 0) {
        const { data: orgs } = await aidwar.from("organizations").select("id, name").in("id", orgIds);
        for (const o of (orgs ?? []) as { id: string; name: string }[]) orgName.set(o.id, o.name);
      }
      for (const m of memberRows) {
        const entries = byUser.get(m.user_id) ?? [];
        entries.push({ org: orgName.get(m.organization_id) ?? "Unknown workspace", role: m.role });
        byUser.set(m.user_id, entries);
      }
    }

    setRows(list.map((p) => ({ ...p, memberships: byUser.get(p.id) ?? [] })));
    setTotal(count ?? list.length);
  }, [page, search, superOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtersActive = Boolean(search || superOnly);

  return (
    <>
      <PageHeader title="Users" description="Everyone with an AiDwar account and the workspaces they belong to." />
      {error ? <div className="mb-6"><ErrorState message={error} /></div> : null}

      <div className="mb-6 grid gap-4 rounded-2xl border border-border/70 bg-card p-5 shadow-sm sm:grid-cols-[1fr_auto] sm:items-end">
        <div className="space-y-2">
          <Label htmlFor="user_q">Search</Label>
          <div className="relative max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="user_q"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Name or email…"
              className="pl-9"
            />
          </div>
        </div>
        <div className="flex items-center gap-2 pb-2">
          <Switch
            id="super_only"
            checked={superOnly}
            onCheckedChange={(v) => {
              setSuperOnly(v);
              setPage(0);
            }}
          />
          <Label htmlFor="super_only" className="text-sm">Super admins only</Label>
        </div>
      </div>

      {!rows ? (
        <TableSkeleton />
      ) : total === 0 && !filtersActive ? (
        <EmptyState icon={Users} title="No users yet" description="Accounts will show up here after the first signup." />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-semibold">User</th>
                  <th className="px-4 py-3 font-semibold">Email</th>
                  <th className="px-4 py-3 font-semibold">Workspaces</th>
                  <th className="px-4 py-3 font-semibold">Joined</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {rows.map((r) => (
                  <tr key={r.id} className="transition-colors duration-200 hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-2 font-medium text-foreground">
                        {r.full_name || "—"}
                        {r.is_super_admin ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                            <ShieldCheck className="h-3 w-3" /> Super admin
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{r.email || "—"}</td>
                    <td className="px-4 py-3">
                      {r.memberships.length === 0 ? (
                        <span className="text-muted-foreground">No workspace</span>
                      ) : (
                        <span className="flex flex-wrap gap-1.5">
                          {r.memberships.map((m) => (
                            <span
                              key={`${r.id}-${m.org}-${m.role}`}
                              className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground"
                            >
                              {m.org} · <span className="capitalize">{m.role}</span>
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {r.created_at ? new Date(r.created_at).toLocaleDateString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length === 0 ? (
            <NoResults message="No users match your filters." />
          ) : (
            <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
          )}
        </div>
      )}
    </>
  );
}
