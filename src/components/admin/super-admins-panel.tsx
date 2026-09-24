import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, UserMinus, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/empty-state";
import { callApi } from "@/lib/whatsapp-client";

type Admin = { id: string; full_name: string | null; email: string | null; created_at: string };
type Res = { admins: Admin[]; me: string; emailed?: boolean };

export function SuperAdminsPanel({ onChanged }: { onChanged?: () => void }) {
  const [admins, setAdmins] = useState<Admin[] | null>(null);
  const [me, setMe] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const apply = (d: Res | null) => {
    if (!d) return;
    setAdmins(d.admins);
    setMe(d.me);
  };

  const load = useCallback(async () => {
    const { data, error: err } = await callApi<Res>("/api/admin/super-admins", { body: { action: "list" } });
    if (err) setError(err);
    else apply(data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (body: Record<string, unknown>, key: string, ok: string) => {
    setBusy(key);
    const { data, error: err } = await callApi<Res>("/api/admin/super-admins", { body });
    setBusy(null);
    if (err) return toast.error(err);
    apply(data);
    toast.success(data?.emailed ? `${ok} We emailed them.` : `${ok} Email isn't set up yet, so no email was sent.`);
    onChanged?.();
    return true;
  };

  if (error) return <ErrorState message={error} />;

  return (
    <section className="mb-6 rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold">Super admins</h2>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        People with full access to every workspace. Every change is recorded.
      </p>

      <form
        className="mt-4 flex max-w-lg flex-col gap-2 sm:flex-row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await act({ action: "grant", email }, "grant", "Super admin added.")) setEmail("");
        }}
      >
        <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email of an existing account" />
        <Button type="submit" disabled={busy !== null || !email.trim()}>
          <UserPlus className="mr-1.5 h-4 w-4" />
          {busy === "grant" ? "Adding…" : "Add"}
        </Button>
      </form>

      <div className="mt-4 divide-y divide-border/60">
        {admins === null
          ? Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="my-2 h-10 w-full rounded-lg" />)
          : admins.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {a.full_name || a.email || "—"} {a.id === me ? <span className="text-xs text-muted-foreground">(you)</span> : null}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{a.email}</p>
                </div>
                {a.id !== me && admins.length > 1 ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => {
                      if (window.confirm(`Remove super admin access for ${a.email ?? "this person"}?`))
                        void act({ action: "revoke", user_id: a.id }, a.id, "Super admin removed.");
                    }}
                  >
                    <UserMinus className="mr-1.5 h-4 w-4" />
                    {busy === a.id ? "Removing…" : "Remove"}
                  </Button>
                ) : null}
              </div>
            ))}
      </div>
    </section>
  );
}
