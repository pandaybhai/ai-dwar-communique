import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  Download,
  FileText,
  HandCoins,
  Loader2,
  Receipt,
  Sparkles,
  Wallet,
} from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { callApi } from "@/lib/whatsapp-client";
import { usePermissions } from "@/hooks/use-permissions";
import {
  type BillingSummary,
  type CreditPack,
  type LedgerEntry,
  ledgerLabel,
  money,
  rateMoney,
} from "@/lib/billing";

const CATEGORY_COPY: Record<string, string> = {
  marketing: "Promotions and offers",
  utility: "Order and account updates",
  authentication: "One-time passcodes",
  service: "Replies inside the 24-hour window",
};

export function BillingView({ organizationId }: { organizationId: string }) {
  const { can } = usePermissions();
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);
  const [buyOpen, setBuyOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await callApi<BillingSummary>(
      `/api/billing/summary?organization_id=${organizationId}`,
      { method: "GET" },
    );
    setLoading(false);
    if (error || !data) {
      setFailed(error ?? "We couldn't load your billing just now.");
      return;
    }
    setFailed(null);
    setSummary(data);
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Coming back from a payment link: poll briefly so the balance catches up.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has("payment")) return;
    let tries = 0;
    const timer = window.setInterval(() => {
      tries += 1;
      void load();
      if (tries >= 5) window.clearInterval(timer);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [load]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32 rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  if (failed || !summary) {
    return (
      <EmptyState
        icon={Wallet}
        title="We couldn't load your billing"
        description={failed ?? "Please try again in a moment."}
        action={
          <Button
            onClick={() => {
              setLoading(true);
              void load();
            }}
          >
            Try again
          </Button>
        }
      />
    );
  }

  const wallet = summary.wallet;
  const low = wallet.available <= summary.settings.low_credit_threshold;
  const aiUsed = summary.ai_answers.used;
  const aiIncluded = summary.ai_answers.included;

  return (
    <div className="space-y-6">
      {low ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900">
          <span className="font-semibold">Credits are running low.</span> Top up so your campaigns
          and replies keep going out.
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Wallet}
          label="Credits available"
          value={money(wallet.available, wallet.currency)}
          hint={wallet.held > 0 ? `${money(wallet.held, wallet.currency)} held for campaigns` : "Ready to spend"}
        />
        <StatCard
          icon={Receipt}
          label="Spent this month"
          value={money(summary.usage_total, wallet.currency)}
          hint={`Since ${new Date(summary.period.start).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`}
        />
        <StatCard
          icon={Sparkles}
          label="AI answers"
          value={aiIncluded > 0 ? `${aiUsed} of ${aiIncluded}` : String(aiUsed)}
          hint={aiIncluded > 0 ? "Included in your plan this month" : "Charged as you go"}
        />
        <StatCard
          icon={HandCoins}
          label="Your plan"
          value={summary.plan.name ?? "No plan yet"}
          hint={
            summary.plan.price_monthly
              ? `${money(summary.plan.price_monthly, wallet.currency)} a month`
              : "Talk to us about a plan"
          }
        />
      </div>

      <div className="flex flex-wrap gap-3">
        {can("billing.pay") ? (
          <Button onClick={() => setBuyOpen(true)} className="rounded-full">
            Buy credits
          </Button>
        ) : null}
        {can("billing.request") && !can("billing.pay") ? (
          <Button variant="outline" className="rounded-full" onClick={() => setAskOpen(true)}>
            Request a top-up
          </Button>
        ) : null}
      </div>

      {aiIncluded > 0 ? (
        <Card className="rounded-2xl">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">AI answers used this month</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Progress value={Math.min(100, (aiUsed / Math.max(aiIncluded, 1)) * 100)} />
            <p className="text-sm text-muted-foreground">
              {aiUsed} of {aiIncluded} included answers used.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle className="text-base">Where your credits went</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {summary.usage.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing spent yet this month — your first campaign will show up here.
              </p>
            ) : (
              summary.usage.map((bucket) => (
                <div key={bucket.category} className="flex items-center justify-between text-sm">
                  <span>{bucket.label}</span>
                  <span className="font-medium">{money(bucket.amount, wallet.currency)}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle className="text-base">What a message costs you</CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <tbody>
                {summary.rates.map((rate) => (
                  <tr key={rate.category} className="border-b last:border-0">
                    <td className="py-2">{CATEGORY_COPY[rate.category] ?? rate.category}</td>
                    <td className="py-2 text-right font-medium">
                      {rate.rate === null ? "—" : rateMoney(rate.rate, rate.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-xs text-muted-foreground">
              Prices are per message, before 18% GST. Replies inside the 24-hour window are free.
            </p>
          </CardContent>
        </Card>
      </div>

      <HistoryTabs organizationId={organizationId} currency={wallet.currency} />

      <BuyCreditsDialog
        open={buyOpen}
        onOpenChange={setBuyOpen}
        organizationId={organizationId}
        packs={summary.packs}
      />
      <RequestTopupDialog
        open={askOpen}
        onOpenChange={setAskOpen}
        organizationId={organizationId}
      />
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Wallet;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <Card className="rounded-2xl">
      <CardContent className="space-y-1 p-5">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Icon className="h-4 w-4 text-emerald-600" />
          {label}
        </div>
        <p className="font-heading text-2xl font-bold">{value}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

type DocRow = Record<string, unknown>;

function HistoryTabs({
  organizationId,
  currency,
}: {
  organizationId: string;
  currency: string;
}) {
  const [tab, setTab] = useState("ledger");
  const [rows, setRows] = useState<DocRow[]>([]);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let live = true;
    setBusy(true);
    void callApi<{ entries: DocRow[] }>(
      `/api/billing/ledger?organization_id=${organizationId}&kind=${tab}`,
      { method: "GET" },
    ).then(({ data }) => {
      if (!live) return;
      setRows(data?.entries ?? []);
      setBusy(false);
    });
    return () => {
      live = false;
    };
  }, [organizationId, tab]);

  const csv = useMemo(() => {
    if (rows.length === 0) return "";
    const headers = Object.keys(rows[0] as object);
    const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    return [
      headers.join(","),
      ...rows.map((row) => headers.map((h) => escape((row as DocRow)[h])).join(",")),
    ].join("\n");
  }, [rows]);

  const download = () => {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `aidwar-${tab}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card className="rounded-2xl">
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-base">History</CardTitle>
        {rows.length > 0 ? (
          <Button variant="outline" size="sm" className="rounded-full" onClick={download}>
            <Download className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="mb-4">
            <TabsTrigger value="ledger">Credits</TabsTrigger>
            <TabsTrigger value="payments">Payments</TabsTrigger>
            <TabsTrigger value="invoices">Invoices</TabsTrigger>
          </TabsList>

          <TabsContent value={tab} className="mt-0">
            {busy ? (
              <div className="space-y-2">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-10 rounded-lg" />
                ))}
              </div>
            ) : rows.length === 0 ? (
              <EmptyState
                icon={FileText}
                title="Nothing here yet"
                description="Once credits move, payments are made or invoices are raised, they'll appear here."
              />
            ) : tab === "ledger" ? (
              <LedgerTable rows={rows as unknown as LedgerEntry[]} currency={currency} />
            ) : (
              <SimpleTable rows={rows} currency={currency} />
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function LedgerTable({ rows, currency }: { rows: LedgerEntry[]; currency: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-sm">
        <thead className="text-left text-xs uppercase text-muted-foreground">
          <tr>
            <th className="py-2">When</th>
            <th className="py-2">What happened</th>
            <th className="py-2 text-right">Amount</th>
            <th className="py-2 text-right">Balance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t">
              <td className="py-2 text-muted-foreground">
                {new Date(row.created_at).toLocaleDateString("en-IN", {
                  day: "numeric",
                  month: "short",
                })}
              </td>
              <td className="py-2">{row.description || ledgerLabel(row.entry_type)}</td>
              <td
                className={`py-2 text-right font-medium ${Number(row.amount) < 0 ? "text-foreground" : "text-emerald-600"}`}
              >
                {money(Number(row.amount), row.currency || currency)}
              </td>
              <td className="py-2 text-right text-muted-foreground">
                {money(Number(row.balance_after), row.currency || currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SimpleTable({ rows, currency }: { rows: DocRow[]; currency: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-sm">
        <tbody>
          {rows.map((row) => {
            const id = String(row["id"] ?? "");
            const when = String(row["issue_date"] ?? row["paid_at"] ?? row["created_at"] ?? "");
            return (
              <tr key={id} className="border-t">
                <td className="py-2 text-muted-foreground">
                  {when ? new Date(when).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—"}
                </td>
                <td className="py-2">
                  {String(row["invoice_number"] ?? row["purpose"] ?? "Payment")}
                </td>
                <td className="py-2 capitalize text-muted-foreground">
                  {String(row["status"] ?? "")}
                </td>
                <td className="py-2 text-right font-medium">
                  {money(Number(row["total"] ?? row["amount"] ?? 0), String(row["currency"] ?? currency))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BuyCreditsDialog({
  open,
  onOpenChange,
  organizationId,
  packs,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
  packs: CreditPack[];
}) {
  const [packId, setPackId] = useState<string | null>(null);
  const [coupon, setCoupon] = useState("");
  const [busy, setBusy] = useState(false);

  const buy = async () => {
    if (!packId) return;
    setBusy(true);
    const { data, error } = await callApi<{ url: string }>("/api/billing/purchase", {
      body: { organization_id: organizationId, pack_id: packId, coupon_code: coupon || null },
    });
    setBusy(false);
    if (error || !data?.url) {
      toast.error(error ?? "We couldn't start that payment. Please try again.");
      return;
    }
    window.location.href = data.url;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Buy credits</DialogTitle>
          <DialogDescription>
            Credits pay for the messages you send. Pick a pack — you'll be taken to a secure payment
            page and brought straight back.
          </DialogDescription>
        </DialogHeader>

        {packs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No credit packs are available right now. Please contact us and we'll sort it out.
          </p>
        ) : (
          <div className="space-y-2">
            {packs.map((pack) => (
              <button
                key={pack.id}
                type="button"
                onClick={() => setPackId(pack.id)}
                className={`flex w-full items-center justify-between rounded-xl border p-4 text-left transition-all duration-200 ${
                  packId === pack.id
                    ? "border-emerald-500 bg-emerald-50"
                    : "hover:border-emerald-300"
                }`}
              >
                <span>
                  <span className="block font-medium">{pack.name}</span>
                  {pack.bonus_amount > 0 ? (
                    <span className="text-xs text-emerald-600">
                      + {money(pack.bonus_amount, pack.currency)} bonus credits
                    </span>
                  ) : null}
                </span>
                <span className="font-heading font-bold">{money(pack.amount, pack.currency)}</span>
              </button>
            ))}
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="coupon">Coupon code (optional)</Label>
          <Input
            id="coupon"
            value={coupon}
            onChange={(event) => setCoupon(event.target.value.toUpperCase())}
            placeholder="AIDWAR10"
          />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={buy} disabled={!packId || busy} className="rounded-full">
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowUpRight className="mr-2 h-4 w-4" />}
            Continue to payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RequestTopupDialog({
  open,
  onOpenChange,
  organizationId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const send = async () => {
    setBusy(true);
    const { error } = await callApi("/api/billing/request-topup", {
      body: { organization_id: organizationId, note: note || null },
    });
    setBusy(false);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success("Sent — the owner of this workspace has been told.");
    onOpenChange(false);
    setNote("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request a top-up</DialogTitle>
          <DialogDescription>
            We'll let the workspace owner know that credits are needed.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Add a short note — what you're planning to send, for example."
          rows={3}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={send} disabled={busy} className="rounded-full">
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Send request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
