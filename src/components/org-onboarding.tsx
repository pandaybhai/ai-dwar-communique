import { useEffect, useState } from "react";
import { Building2, Loader2, MessageCircle, Copy, Check } from "lucide-react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { aidwar } from "@/integrations/aidwar/client";
import { callApi } from "@/lib/whatsapp-client";
import { logActivity } from "@/lib/activity";
import { ATTRIBUTION_STORAGE_KEY } from "@/routes/signup";

type Handoff = { code: string; wa_link: string };

/** Whatever the signup link carried — stored at /signup, spent here, then cleared. */
function takeAttribution(): Record<string, string> {
  try {
    const raw = window.sessionStorage.getItem(ATTRIBUTION_STORAGE_KEY);
    if (!raw) return {};
    window.sessionStorage.removeItem(ATTRIBUTION_STORAGE_KEY);
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function OrgOnboarding({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [business, setBusiness] = useState("");
  const [copied, setCopied] = useState(false);
  const [qr, setQr] = useState<string | null>(null);

  useEffect(() => {
    if (!handoff?.wa_link) return;
    let live = true;
    QRCode.toDataURL(handoff.wa_link, { width: 320, margin: 1 })
      .then((url) => {
        if (live) setQr(url);
      })
      .catch(() => {
        if (live) setQr(null);
      });
    return () => {
      live = false;
    };
  }, [handoff?.wa_link]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (name.trim().length < 2) {
      setError("Please enter a business name with at least 2 characters.");
      return;
    }
    setPending(true);
    setError(null);
    const { data: newOrgId, error: err } = await aidwar.rpc("create_organization", { org_name: name.trim() });
    if (err) {
      setPending(false);
      setError("We couldn't create your workspace. Please try again.");
      return;
    }
    await logActivity("organization.created", (newOrgId as string) ?? null, { name: name.trim() });

    // Aiden meets the owner on WhatsApp. If that can't be arranged right now,
    // the workspace still opens — nobody gets stuck on this screen.
    const started = await callApi<Handoff>("/api/onboarding/start", {
      body: { organization_id: (newOrgId as string) ?? null },
    });
    setPending(false);
    if (started.data?.wa_link) {
      setBusiness(name.trim());
      setHandoff(started.data);
      return;
    }
    onCreated();
  }

  if (handoff) {
    return (
      <div className="mx-auto max-w-lg py-8 text-center animate-in fade-in slide-in-from-bottom-2 duration-500">
        <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <MessageCircle className="h-8 w-8" />
        </span>
        <h1 className="mt-6 text-3xl font-bold tracking-tight text-foreground">
          Aiden is ready to meet you
        </h1>
        <p className="mx-auto mt-3 max-w-sm text-muted-foreground">
          He's your new employee at {business}. Say hello and he'll learn your business in a few
          minutes — right in your own chats.
        </p>

        <Button
          asChild
          size="lg"
          className="mt-8 h-14 w-full rounded-full text-base transition-all duration-200"
        >
          <a href={handoff.wa_link} target="_blank" rel="noreferrer">
            Say hello to Aiden
          </a>
        </Button>

        <div className="mt-5 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <span>Your code: </span>
          <code className="rounded-md bg-muted px-2 py-1 font-mono text-foreground">{handoff.code}</code>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(handoff.code);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }}
            className="rounded-md p-1 text-muted-foreground transition-colors duration-150 hover:text-foreground"
            aria-label="Copy your code"
          >
            {copied ? <Check className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4" />}
          </button>
        </div>

        <button
          type="button"
          onClick={onCreated}
          className="mt-8 text-sm font-medium text-muted-foreground underline-offset-4 transition-colors duration-150 hover:text-foreground hover:underline"
        >
          Skip for now — open my workspace
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg py-8 lg:py-16">
      <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
        <span className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
          <Building2 className="h-3.5 w-3.5" /> Step 1 of 2
        </span>
        <h1 className="mt-4 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
          What's your business called?
        </h1>
        <p className="mt-3 text-muted-foreground">
          Aiden will use this name when he talks to your customers. You can change it any time.
        </p>

        <form onSubmit={onSubmit} className="mt-8 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="org_name">Business name</Label>
            <Input
              id="org_name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Meezoy Ventures"
              autoFocus
              required
            />
          </div>
          {error ? (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
          ) : null}
          <Button
            type="submit"
            size="lg"
            className="h-12 w-full rounded-full transition-all duration-200"
            disabled={pending}
          >
            {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Continue
          </Button>
        </form>
      </div>
    </div>
  );
}
