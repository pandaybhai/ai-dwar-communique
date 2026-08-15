import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Loader2,
  MessageCircle,
  PlugZap,
  Send,
  ShieldCheck,
  Unplug,
  ChevronDown,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ErrorState } from "@/components/empty-state";
import { aidwar } from "@/integrations/aidwar/client";
import { normalizePhone } from "@/lib/phone";
import { callApi } from "@/lib/whatsapp-client";
import { useOrg } from "@/lib/org-context";
import { EmbeddedSignupButton } from "@/components/whatsapp-embedded-signup";
import { QualityBanner } from "@/components/whatsapp-quality-banner";

type Account = {
  id: string;
  display_phone_number: string | null;
  verified_name: string | null;
  quality_rating: string | null;
  status: string;
  connected_at: string | null;
  phone_number_id: string;
  waba_id: string | null;
};

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm sm:p-8">{children}</div>;
}

export function WhatsAppTab() {
  const { active, canManage } = useOrg();
  const orgId = active?.organization.id;
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await aidwar
      .from("whatsapp_accounts")
      .select(
        "id, display_phone_number, verified_name, quality_rating, status, connected_at, phone_number_id, waba_id",
      )
      .eq("organization_id", orgId)
      .order("connected_at", { ascending: false, nullsFirst: false })
      .limit(1);
    setLoading(false);
    if (err) {
      setError("We couldn't load your connection. Please refresh.");
      return;
    }
    setAccount(((data ?? [])[0] as Account) ?? null);
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-32 w-full rounded-2xl" />
      </div>
    );
  }

  if (error) return <ErrorState message={error} />;

  return (
    <div className="space-y-6">
      <QualityBanner organizationId={orgId} />
      {account && account.status === "active" ? (
        <>
          <ConnectedCard account={account} canManage={canManage} onChanged={load} orgId={orgId!} />
          {canManage ? <TestConsole orgId={orgId!} /> : null}
        </>
      ) : (
        <ConnectCard
          canManage={canManage}
          onConnected={load}
          orgId={orgId!}
          previous={account}
        />
      )}
    </div>
  );
}

function ConnectCard({
  canManage,
  onConnected,
  orgId,
  previous,
}: {
  canManage: boolean;
  onConnected: () => Promise<void>;
  orgId: string;
  previous?: Account | null;
}) {
  const [waba, setWaba] = useState("");
  const [phoneId, setPhoneId] = useState("");
  const [display, setDisplay] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [showManual, setShowManual] = useState(false);

  if (!canManage) {
    return (
      <Card>
        <div className="flex items-start gap-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <MessageCircle className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-base font-semibold text-foreground">
              {previous ? "Number disconnected" : "No number connected yet"}
            </h2>
            <p className="mt-1 max-w-md text-sm text-muted-foreground">
              An owner or admin needs to connect your business number before your team can send messages.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const { error } = await callApi("/api/whatsapp/connect", {
      body: {
        organization_id: orgId,
        waba_id: waba.trim(),
        phone_number_id: phoneId.trim(),
        display_phone_number: display.trim(),
        access_token: token.trim(),
      },
    });
    setSaving(false);
    if (error) {
      toast.error(error);
      return;
    }
    setToken("");
    toast.success("Business number connected");
    await onConnected();
  }

  return (
    <>
      <Card>
        <div className="flex items-start gap-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <PlugZap className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-base font-semibold text-foreground">
              {previous ? "Reconnect your business number" : "Connect your business number"}
            </h2>
            <p className="mt-1 max-w-lg text-sm text-muted-foreground">
              {previous
                ? `${previous.display_phone_number ?? "Your number"} was disconnected and its access token revoked. Run sign-up again to start sending.`
                : "Sign in with Facebook and pick the business number you want to message from. It takes about two minutes — we handle the setup for you."}
            </p>
          </div>
        </div>

        <div className="mt-6">
          <EmbeddedSignupButton orgId={orgId} onConnected={onConnected} />
        </div>

        <button
          type="button"
          onClick={() => setShowManual((v) => !v)}
          className="mt-6 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors duration-200 hover:text-foreground"
        >
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform duration-200 ${showManual ? "rotate-180" : ""}`}
          />
          Advanced: connect manually
        </button>
      </Card>

      {showManual ? (
        <Card>
          <div>
            <h2 className="text-base font-semibold text-foreground">Connect manually (developer mode)</h2>
            <p className="mt-1 max-w-lg text-sm text-muted-foreground">
              Paste the details from your Meta app to connect a test or production business number. Your access token
              is stored securely on our servers and is never exposed to the browser.
            </p>
          </div>

          <form onSubmit={submit} className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="waba_id">WABA ID</Label>
          <Input id="waba_id" value={waba} onChange={(e) => setWaba(e.target.value)} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="phone_number_id">Phone Number ID</Label>
          <Input id="phone_number_id" value={phoneId} onChange={(e) => setPhoneId(e.target.value)} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="display_phone">Display phone number</Label>
          <Input
            id="display_phone"
            placeholder="+91 90000 00000"
            value={display}
            onChange={(e) => setDisplay(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="access_token">Access token</Label>
          <Input
            id="access_token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
          />
        </div>
            <div className="sm:col-span-2 flex items-center gap-3 pt-1">
              <Button type="submit" className="rounded-full" disabled={saving}>
                {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Connect number
              </Button>
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5 text-primary" /> Verified with Meta before saving
              </span>
            </div>
          </form>
        </Card>
      ) : null}
    </>
  );
}

function ConnectedCard({
  account,
  canManage,
  onChanged,
  orgId,
}: {
  account: Account;
  canManage: boolean;
  onChanged: () => Promise<void>;
  orgId: string;
}) {
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function disconnect() {
    setWorking(true);
    setFailure(null);
    const { data, error } = await callApi<{ token_revoked?: boolean }>("/api/whatsapp/connect", {
      method: "DELETE",
      body: { organization_id: orgId },
    });
    setWorking(false);
    if (error) {
      setFailure(error);
      toast.error(error);
      return;
    }
    toast.success(
      data?.token_revoked
        ? "Number disconnected and access revoked"
        : "Number disconnected — you can reconnect anytime",
    );
    await onChanged();
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <CheckCircle2 className="h-5 w-5" />
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-foreground">
                {account.display_phone_number ?? "Connected number"}
              </h2>
              <Badge className="rounded-full bg-primary/10 text-primary hover:bg-primary/10">Active</Badge>
            </div>
            <dl className="mt-3 grid gap-x-8 gap-y-1.5 text-sm sm:grid-cols-2">
              <div className="flex gap-2">
                <dt className="text-muted-foreground">Verified name</dt>
                <dd className="font-medium text-foreground">{account.verified_name ?? "—"}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted-foreground">Quality rating</dt>
                <dd className="font-medium text-foreground">{account.quality_rating ?? "UNKNOWN"}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-muted-foreground">Connected</dt>
                <dd className="font-medium text-foreground">
                  {account.connected_at ? new Date(account.connected_at).toLocaleDateString() : "—"}
                </dd>
              </div>
            </dl>
          </div>
        </div>
        {canManage ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" className="rounded-full" disabled={working}>
                {working ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Unplug className="mr-2 h-4 w-4" />
                )}
                Disconnect
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Disconnect this number?</AlertDialogTitle>
                <AlertDialogDescription>
                  We'll stop incoming messages, revoke the stored access token and remove it from our
                  servers. Your contacts and conversations stay exactly as they are, and you can run
                  sign-up again whenever you're ready.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel className="rounded-full">Keep connected</AlertDialogCancel>
                <AlertDialogAction className="rounded-full" onClick={() => void disconnect()}>
                  Disconnect
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </div>

      {failure ? (
        <div className="mt-6 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {failure}
        </div>
      ) : null}
    </Card>
  );
}

type SendResult = {
  message_id: string | null;
  meta_message_id: string | null;
  provider_response: unknown;
};

function TestConsole({ orgId }: { orgId: string }) {
  const [phone, setPhone] = useState("");
  const [mode, setMode] = useState<"template" | "text">("template");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  function watchStatus(messageId: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      const { data } = await aidwar.from("messages").select("status").eq("id", messageId).maybeSingle();
      if (data?.status) {
        setStatus(data.status as string);
        if (data.status === "read" || data.status === "failed") {
          if (pollRef.current) clearInterval(pollRef.current);
        }
      }
    }, 3000);
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setResult(null);
    setErrorText(null);
    setStatus(null);

    const { data, error } = await callApi<SendResult>("/api/whatsapp/send-message", {
      body: {
        organization_id: orgId,
        phone: normalizePhone(phone),
        message_type: mode,
        ...(mode === "template"
          ? { template_name: "hello_world", template_language: "en_US" }
          : { body: body.trim() }),
      },
    });
    setSending(false);

    if (error) {
      setErrorText(error);
      toast.error(error);
      return;
    }
    setResult(data);
    setStatus("pending");
    toast.success("Message handed to WhatsApp");
    if (data?.message_id) watchStatus(data.message_id);
  }

  const steps = ["pending", "sent", "delivered", "read"];

  return (
    <Card>
      <div className="flex items-start gap-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Send className="h-5 w-5" />
        </span>
        <div>
          <h2 className="text-base font-semibold text-foreground">Send test message</h2>
          <p className="mt-1 max-w-lg text-sm text-muted-foreground">
            Send a live message to verify your connection end to end. Free-form text only works within 24 hours of
            the contact's last message — otherwise use the template.
          </p>
        </div>
      </div>

      <form onSubmit={send} className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="test_phone">Recipient phone (E.164)</Label>
          <Input
            id="test_phone"
            placeholder="+919000000000"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="test_mode">Message</Label>
          <Select value={mode} onValueChange={(v) => setMode(v as "template" | "text")}>
            <SelectTrigger id="test_mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="template">Template — hello_world (en_US)</SelectItem>
              <SelectItem value="text">Free text</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {mode === "text" ? (
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="test_body">Message text</Label>
            <Textarea
              id="test_body"
              rows={3}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Hi! Just checking our WhatsApp connection."
              required
            />
          </div>
        ) : null}
        <div className="sm:col-span-2">
          <Button type="submit" className="rounded-full" disabled={sending}>
            {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Send test message
          </Button>
        </div>
      </form>

      <div className="mt-6 rounded-xl border border-dashed border-border/70 bg-muted/30 p-5">
        {sending ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-40 rounded-full" />
            <Skeleton className="h-4 w-64 rounded-full" />
          </div>
        ) : errorText ? (
          <p className="text-sm text-destructive">{errorText}</p>
        ) : result ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              {steps.map((s) => {
                const reached = status ? steps.indexOf(status) >= steps.indexOf(s) : false;
                return (
                  <Badge
                    key={s}
                    variant={reached ? "default" : "outline"}
                    className={
                      reached
                        ? "rounded-full bg-primary text-primary-foreground hover:bg-primary"
                        : "rounded-full text-muted-foreground"
                    }
                  >
                    {s}
                  </Badge>
                );
              })}
              {status === "failed" ? (
                <Badge variant="destructive" className="rounded-full">
                  failed
                </Badge>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              Status updates arrive from WhatsApp through the webhook and refresh here automatically.
            </p>
            <pre className="max-h-48 overflow-auto rounded-lg bg-background p-3 text-xs text-muted-foreground">
              {JSON.stringify(result.provider_response, null, 2)}
            </pre>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No test sent yet. Results and live delivery status will appear here.
          </p>
        )}
      </div>
    </Card>
  );
}
