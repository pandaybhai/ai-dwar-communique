import { applyScope, useAdminScope } from "@/lib/admin-scope";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Activity, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, ErrorState, PageHeader } from "@/components/empty-state";
import { NoResults, Pagination, TableSkeleton } from "@/components/data-pagination";
import { aidwar } from "@/integrations/aidwar/client";

export const Route = createFileRoute("/admin/activity")({
  head: () => ({
    meta: [
      { title: "Activity — AiDwar Admin" },
      { name: "description", content: "Cross-organization audit trail of significant actions." },
      { property: "og:title", content: "Activity — AiDwar Admin" },
      { property: "og:description", content: "Cross-organization audit trail of significant actions." },
    ],
  }),
  component: AdminActivity,
});

const PAGE_SIZE = 50;

type LogRow = {
  id: string;
  organization_id: string | null;
  user_id: string | null;
  action: string;
  details: Record<string, unknown> | null;
  created_at: string;
};

function Select({
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

function AdminActivity() {
  const [rows, setRows] = useState<LogRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [orgs, setOrgs] = useState<{ id: string; name: string }[]>([]);
  const [users, setUsers] = useState<{ id: string; label: string }[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [orgId, setOrgId] = useState("");
  const [userId, setUserId] = useState("");
  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(query.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    (async () => {
      const [{ data: o }, { data: p }] = await Promise.all([
        aidwar.from("organizations").select("id, name").order("name").limit(500),
        aidwar.from("profiles").select("id, full_name, email").limit(500),
      ]);
      setOrgs((o ?? []) as { id: string; name: string }[]);
      setUsers(
        ((p ?? []) as { id: string; full_name: string | null; email: string | null }[]).map((u) => ({
          id: u.id,
          label: u.full_name || u.email || u.id.slice(0, 8),
        })),
      );
    })();
  }, []);

  const scope = useAdminScope();
  const load = useCallback(async () => {
    setError(null);
    setRows(null);

    let q = applyScope(
      aidwar
        .from("activity_log")
        .select("id, organization_id, user_id, action, details, created_at", { count: "exact" })
        .order("created_at", { ascending: false })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1),
      scope,
    );

    if (orgId) q = q.eq("organization_id", orgId);
    if (userId) q = q.eq("user_id", userId);
    if (action) q = q.eq("action", action);
    if (search) q = q.ilike("action", `%${search}%`);
    if (from) q = q.gte("created_at", new Date(`${from}T00:00:00`).toISOString());
    if (to) q = q.lte("created_at", new Date(`${to}T23:59:59`).toISOString());

    const { data, error: err, count } = await q;
    if (err) {
      setError("We couldn't load activity. Please refresh.");
      setRows([]);
      setTotal(0);
      return;
    }
    const list = (data ?? []) as LogRow[];
    setRows(list);
    setTotal(count ?? list.length);
    setActions((prev) => Array.from(new Set([...prev, ...list.map((r) => r.action)])).sort());
  }, [orgId, userId, action, search, from, to, page, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  const userName = new Map(users.map((u) => [u.id, u.label]));
  const filtersActive = Boolean(orgId || userId || action || search || from || to);

  function reset<T>(setter: (v: T) => void) {
    return (v: T) => {
      setter(v);
      setPage(0);
    };
  }

  return (
    <>
      <PageHeader title="Activity" description="Cross-organization audit trail of every significant action on AiDwar." />
      {error ? <div className="mb-6"><ErrorState message={error} /></div> : null}

      <div className="mb-6 grid gap-4 rounded-2xl border border-border/70 bg-card p-5 shadow-sm sm:grid-cols-2 lg:grid-cols-6">
        <div className="space-y-2 lg:col-span-2">
          <Label htmlFor="f_search">Search action</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="f_search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="e.g. campaign"
              className="pl-9"
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="f_org">Organization</Label>
          <Select id="f_org" value={orgId} onChange={reset(setOrgId)}>
            <option value="">All organizations</option>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="f_user">User</Label>
          <Select id="f_user" value={userId} onChange={reset(setUserId)}>
            <option value="">All users</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.label}</option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="f_action">Action</Label>
          <Select id="f_action" value={action} onChange={reset(setAction)}>
            <option value="">All actions</option>
            {actions.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="f_from">From</Label>
          <Input id="f_from" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(0); }} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="f_to">To</Label>
          <Input id="f_to" type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(0); }} />
        </div>
      </div>

      {!rows ? (
        <TableSkeleton rows={8} />
      ) : total === 0 && !filtersActive ? (
        <EmptyState
          icon={Activity}
          title="No activity to show"
          description="Once customers log in, create workspaces and invite teammates, their actions appear here."
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-semibold">When</th>
                  <th className="px-4 py-3 font-semibold">Action</th>
                  <th className="px-4 py-3 font-semibold">Organization</th>
                  <th className="px-4 py-3 font-semibold">User</th>
                  <th className="px-4 py-3 font-semibold">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {rows.map((r) => (
                  <tr key={r.id} className="transition-colors duration-200 hover:bg-muted/30">
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                      {new Date(r.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
                        {r.action}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {r.organization_id ? orgName.get(r.organization_id) ?? "—" : "—"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {r.user_id ? userName.get(r.user_id) ?? "—" : "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {r.details && Object.keys(r.details).length > 0 ? JSON.stringify(r.details) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length === 0 ? (
            <NoResults message="No activity matches your filters." />
          ) : (
            <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
          )}
        </div>
      )}
    </>
  );
}
