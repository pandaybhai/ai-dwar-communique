import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ShieldCheck, Users } from "lucide-react";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorState, PageHeader, PageSkeleton } from "@/components/empty-state";
import { aidwar } from "@/integrations/aidwar/client";

export const Route = createFileRoute("/admin/users")({
  component: AdminUsers,
});

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
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    (async () => {
      const [{ data: profiles, error: err }, { data: members }, { data: orgs }] = await Promise.all([
        aidwar.from("profiles").select("id, full_name, email, is_super_admin, created_at"),
        aidwar.from("organization_members").select("user_id, organization_id, role"),
        aidwar.from("organizations").select("id, name"),
      ]);
      if (err) {
        setError("We couldn't load users. Please refresh.");
        setRows([]);
        return;
      }
      const orgName = new Map(((orgs ?? []) as { id: string; name: string }[]).map((o) => [o.id, o.name]));
      const byUser = new Map<string, { org: string; role: string }[]>();
      for (const m of (members ?? []) as { user_id: string; organization_id: string; role: string }[]) {
        const list = byUser.get(m.user_id) ?? [];
        list.push({ org: orgName.get(m.organization_id) ?? "Unknown workspace", role: m.role });
        byUser.set(m.user_id, list);
      }
      setRows(
        ((profiles ?? []) as Omit<Row, "memberships">[]).map((p) => ({
          ...p,
          memberships: byUser.get(p.id) ?? [],
        })),
      );
    })();
  }, []);

  if (!rows) return <PageSkeleton />;

  const q = query.trim().toLowerCase();
  const filtered = rows.filter(
    (r) => !q || (r.email ?? "").toLowerCase().includes(q) || (r.full_name ?? "").toLowerCase().includes(q),
  );

  return (
    <>
      <PageHeader title="Users" description="Everyone with an AiDwar account and the workspaces they belong to." />
      {error ? <div className="mb-6"><ErrorState message={error} /></div> : null}

      {rows.length === 0 ? (
        <EmptyState icon={Users} title="No users yet" description="Accounts will show up here after the first signup." />
      ) : (
        <div className="space-y-4">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or email…"
            className="max-w-sm"
          />
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
                  {filtered.map((r) => (
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
            {filtered.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">No users match “{query}”.</p>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}
