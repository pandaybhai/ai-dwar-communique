import { useEffect, useRef, useState } from "react";
import { FlaskConical, RotateCcw, Search, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { callApi } from "@/lib/whatsapp-client";

type Org = { id: string; name: string };
type Turn = { role: "user" | "assistant"; content: string };
type Reply = {
  status: string;
  reply: string;
  error: string | null;
  needs_owner: boolean;
  escalation: string | null;
  tools: Array<{ tool: string; ok: boolean }>;
  media: Array<{ title: string; image_url: string; price: number | null; currency: string | null }>;
  latency_ms: number;
};
type Bubble = { role: "user" | "assistant"; content: string; meta?: Reply };

const api = (body: Record<string, unknown>) => callApi<Record<string, unknown>>("/api/admin/ai", { body });

export function AidenTestPanel() {
  const [q, setQ] = useState("");
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [org, setOrg] = useState<Org | null>(null);
  const [chat, setChat] = useState<Bubble[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [useDraft, setUseDraft] = useState(false);
  const [draft, setDraft] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(async () => {
      const { data } = await api({ action: "aiden_orgs", q });
      setOrgs(((data?.["organizations"] as Org[]) ?? []).map((o) => ({ id: o.id, name: o.name })));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), [chat, busy]);

  const send = async () => {
    const question = text.trim();
    if (!org || !question || busy) return;
    const history: Turn[] = chat.map((b) => ({ role: b.role, content: b.content }));
    setChat((c) => [...c, { role: "user", content: question }]);
    setText("");
    setBusy(true);
    const { data, error } = await api({
      action: "aiden_test",
      organization_id: org.id,
      question,
      history,
      ...(useDraft && draft.trim() ? { instructions_override: draft } : {}),
    });
    setBusy(false);
    const r = data as unknown as Reply | null;
    const content = error ?? (r?.reply?.trim() ? r.reply : r?.error ?? "No reply.");
    setChat((c) => [...c, { role: "assistant", content, ...(r ? { meta: r } : {}) }]);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
      <div className="space-y-3 rounded-2xl border border-border/70 bg-card p-4 shadow-sm">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search workspaces" className="pl-9" />
        </div>
        <div className="max-h-[50vh] space-y-1 overflow-auto">
          {orgs === null
            ? Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-8 w-full rounded-lg" />)
            : orgs.length === 0
              ? <p className="py-4 text-center text-sm text-muted-foreground">No workspace matches.</p>
              : orgs.map((o) => (
                  <button
                    key={o.id}
                    onClick={() => { setOrg(o); setChat([]); }}
                    className={`w-full rounded-lg px-3 py-2 text-left text-sm transition-colors duration-150 ${org?.id === o.id ? "bg-primary/10 font-medium text-primary" : "hover:bg-muted/60"}`}
                  >
                    {o.name}
                  </button>
                ))}
        </div>
      </div>

      {!org ? (
        <EmptyState icon={FlaskConical} title="Pick a workspace to test" description="Chat as a customer. Nothing is sent to anyone and nothing is charged." />
      ) : (
        <div className="space-y-4 rounded-2xl border border-border/70 bg-card p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-semibold text-foreground">Testing as a customer of {org.name}</h3>
              <p className="text-xs text-muted-foreground">Real answer path with this workspace's knowledge, rules and behaviour. Not sent, not billed, nothing filed under Unanswered.</p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setChat([])} disabled={!chat.length || busy}>
              <RotateCcw className="mr-1 h-4 w-4" /> New chat
            </Button>
          </div>

          <div className="rounded-xl bg-muted/40 p-3">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="draft">Try an unsaved "How I behave" brief</Label>
              <Switch id="draft" checked={useDraft} onCheckedChange={setUseDraft} />
            </div>
            {useDraft ? (
              <Textarea className="mt-2" rows={4} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Paste a draft brief — used only for these test replies." />
            ) : null}
          </div>

          <div className="min-h-[280px] max-h-[55vh] space-y-3 overflow-auto rounded-xl bg-muted/30 p-4">
            {chat.length === 0 && !busy ? (
              <p className="py-10 text-center text-sm text-muted-foreground">Type what a customer would send, e.g. "Do you deliver to Pune?"</p>
            ) : null}
            {chat.map((b, i) => (
              <div key={i} className={`flex ${b.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm shadow-sm ${b.role === "user" ? "rounded-br-sm bg-primary/15 text-foreground" : "rounded-bl-sm bg-card text-foreground"}`}>
                  <p className="whitespace-pre-wrap">{b.content}</p>
                  {b.meta?.media?.length ? (
                    <div className="mt-2 grid grid-cols-3 gap-2">
                      {b.meta.media.slice(0, 3).map((m) => (
                        <div key={m.image_url} className="text-xs">
                          <img src={m.image_url} alt={m.title} className="aspect-square w-full rounded-lg object-cover" loading="lazy" />
                          <p className="mt-1 line-clamp-1">{m.title}</p>
                          {m.price != null ? <p className="text-muted-foreground">{m.currency ?? "₹"} {m.price}</p> : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {b.meta ? (
                    <div className="mt-2 flex flex-wrap gap-1 text-[11px] text-muted-foreground">
                      <span className="rounded-full bg-muted px-2 py-0.5">{b.meta.status}</span>
                      {b.meta.needs_owner ? <span className="rounded-full bg-primary/10 px-2 py-0.5 text-primary">would go to Unanswered</span> : null}
                      {b.meta.escalation ? <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-destructive">hand-over: {b.meta.escalation}</span> : null}
                      {b.meta.tools.map((t, j) => <span key={j} className="rounded-full bg-muted px-2 py-0.5">{t.tool}{t.ok ? "" : " ✕"}</span>)}
                      <span className="px-1">{(b.meta.latency_ms / 1000).toFixed(1)}s</span>
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
            {busy ? <Skeleton className="h-12 w-2/3 rounded-2xl" /> : null}
            <div ref={endRef} />
          </div>

          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Message as a customer…" disabled={busy} />
            <Button type="submit" disabled={busy || !text.trim()}>
              <Send className="mr-1 h-4 w-4" /> Send
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
