import { useCallback, useEffect, useState } from "react";
import { Mail, ShieldCheck, UserMinus, UserPlus, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/empty-state";
import { callApi } from "@/lib/whatsapp-client";

type Admin = { id: string; full_name: string | null; email: string | null; created_at: string };
type Res = { admins: Admin[]; me: string; emailed?: boolean; email_error?: string | null };
type TestRes = { sent: boolean; to: string; id: string | null; error: string | null };

type SalesMember = {
  id: string;
  full_name: string | null;
  email: string | null;
  created_at: string;
};

/**
 * Batch 76: the sales team — people who see Leads & Demos only (status,
 * notes, follow-ups, assigning to themselves, WhatsApp). Nothing else in the
 * admin area, and no workspace powers. Super admin only; every change is
 * recorded in the activity log.
 */
export function SalesTeamSection() {
  const [members, setMembers] = useState<SalesMember[] | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const call = useCallback(async (body: Record<string, unknown>, key: string | null) => {
    setBusy(key);
    const { data, error: err } = await callApi<{ sales: SalesMember[] }>(
      "/api/admin/super-admins",
      { body },
    );
    setBusy(null);
    if (err) {
      if (key) toast.error(err);
      else setError(err);
      return false;
    }
    if (data) setMembers(data.sales);
    return true;
  }, []);
  useEffect(() => {
    void call({ action: "list_sales" }, null);
  }, [call]);
  if (error) return <ErrorState message={error} />;
  return (
    <div className="mt-6 border-t border-border/60 pt-5" data-testid="sales-team">
      <div className="flex items-center gap-2">
        <Users className="h-5 w-5 text-primary" />
        <h3 className="text-base font-semibold">Sales team</h3>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Leads &amp; Demos only — they can work leads, nothing else in the admin area.
      </p>
      <form
        className="mt-3 flex max-w-lg flex-col gap-2 sm:flex-row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await call({ action: "grant_sales", email }, "grant_sales")) {
            setEmail("");
            toast.success("Added to the sales team.");
          }
        }}
      >
        <Input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email of an existing account"
          aria-label="Sales team member email"
        />
        <Button type="submit" disabled={busy !== null || !email.trim()}>
          <UserPlus className="mr-1.5 h-4 w-4" />
          {busy === "grant_sales" ? "Adding…" : "Add"}
        </Button>
      </form>
      <div className="mt-3 divide-y divide-border/60">
        {members === null ? (
          <Skeleton className="my-2 h-10 w-full rounded-lg" />
        ) : members.length === 0 ? (
          <p className="py-2.5 text-sm text-muted-foreground">Nobody yet.</p>
        ) : (
          members.map((m) => (
            <div key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  {m.full_name || m.email || "—"}
                </p>
                <p className="truncate text-xs text-muted-foreground">{m.email}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => {
                  if (window.confirm(`Remove ${m.email ?? "this person"} from the sales team?`))
                    void call({ action: "revoke_sales", user_id: m.id }, m.id).then(
                      (ok) => ok && toast.success("Removed from the sales team."),
                    );
                }}
              >
                <UserMinus className="mr-1.5 h-4 w-4" />
                {busy === m.id ? "Removing…" : "Remove"}
              </Button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function SuperAdminsPanel({ onChanged }: { onChanged?: () => void }) {
  const [admins, setAdmins] = useState<Admin[] | null>(null);
  const [me, setMe] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestRes | null>(null);

  const apply = (d: Res | null) => {
    if (!d) return;
    setAdmins(d.admins);
    setMe(d.me);
  };

  const load = useCallback(async () => {
    const { data, error: err } = await callApi<Res>("/api/admin/super-admins", {
      body: { action: "list" },
    });
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
    const why = data?.email_error;
    toast.success(
      data?.emailed
        ? `${ok} We emailed them.`
        : why === "email_not_configured" || !why
          ? `${ok} Email isn't set up yet, so no email was sent.`
          : `${ok} The email didn't go: ${why}`,
    );
    onChanged?.();
    return true;
  };

  const sendTest = async () => {
    setBusy("test_email");
    setTestResult(null);
    const { data, error: err } = await callApi<TestRes>("/api/admin/super-admins", {
      body: { action: "test_email" },
    });
    setBusy(null);
    if (err) {
      toast.error(err);
      return;
    }
    if (!data) return;
    setTestResult(data);
    if (data.sent) toast.success(`Test email sent to ${data.to}.`);
    else toast.error("The test email didn't go.");
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
        <Input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email of an existing account"
        />
        <Button type="submit" disabled={busy !== null || !email.trim()}>
          <UserPlus className="mr-1.5 h-4 w-4" />
          {busy === "grant" ? "Adding…" : "Add"}
        </Button>
      </form>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() => void sendTest()}
        >
          <Mail className="mr-1.5 h-4 w-4" />
          {busy === "test_email" ? "Sending…" : "Send test email to me"}
        </Button>
        {testResult ? (
          <p
            className={`text-xs ${testResult.sent ? "text-muted-foreground" : "text-destructive"}`}
          >
            {testResult.sent
              ? `Sent to ${testResult.to}${testResult.id ? ` (Resend id ${testResult.id})` : ""}.`
              : testResult.error === "email_not_configured"
                ? "Email isn't set up yet: RESEND_API_KEY is missing."
                : `Not sent: ${testResult.error ?? "unknown error"}`}
          </p>
        ) : null}
      </div>

      <div className="mt-4 divide-y divide-border/60">
        {admins === null
          ? Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="my-2 h-10 w-full rounded-lg" />
            ))
          : admins.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {a.full_name || a.email || "—"}{" "}
                    {a.id === me ? (
                      <span className="text-xs text-muted-foreground">(you)</span>
                    ) : null}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{a.email}</p>
                </div>
                {a.id !== me && admins.length > 1 ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => {
                      if (
                        window.confirm(`Remove super admin access for ${a.email ?? "this person"}?`)
                      )
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
      <SalesTeamSection />
    </section>
  );
}
