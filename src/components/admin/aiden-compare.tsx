import { useEffect, useMemo, useState } from "react";
import { Columns2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { callApi } from "@/lib/whatsapp-client";
import { runBothSides, type CompareRow as Row, type SideRun } from "@/lib/aiden-compare";
import { SendSequence } from "@/components/admin/send-sequence";

type Org = { id: string; name: string };

const api = (body: Record<string, unknown>) => callApi<Record<string, unknown>>("/api/admin/ai", { body });

/** Questions the admin added for this workspace, kept in this browser only. */
const savedKey = (orgId: string) => `aiden-compare-questions:${orgId}`;
function readSaved(orgId: string): string[] {
  try {
    const raw = window.localStorage.getItem(savedKey(orgId));
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((q): q is string => typeof q === "string" && q.trim().length > 0) : [];
  } catch {
    return [];
  }
}
function writeSaved(orgId: string, list: string[]) {
  try {
    window.localStorage.setItem(savedKey(orgId), JSON.stringify(list));
  } catch {
    // private window: the list lives until the page closes
  }
}

/** Questions run two at a time, in the list's order. */
const PARALLEL = 2;

export function AidenComparePanel({ org }: { org: Org }) {
  const [recent, setRecent] = useState<string[] | null>(null);
  const [saved, setSaved] = useState<string[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [current, setCurrent] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [extra, setExtra] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setRecent(null);
    setRows([]);
    setSaved(readSaved(org.id));
    void (async () => {
      const [{ data: q }, { data: b }] = await Promise.all([
        api({ action: "aiden_questions", organization_id: org.id }),
        api({ action: "behaviour_load", organization_id: org.id }),
      ]);
      if (!live) return;
      const questions = ((q?.["questions"] as string[] | undefined) ?? []).slice(0, 20);
      setRecent(questions);
      setPicked(new Set(questions.slice(0, 5)));
      const versions = (b?.["instructions"] as Array<{ is_current?: boolean; instructions?: string | null }> | undefined) ?? [];
      const text = versions.find((v) => v.is_current)?.instructions ?? "";
      setCurrent(text);
      setDraft(text);
    })();
    return () => {
      live = false;
    };
  }, [org.id]);

  const all = useMemo(() => [...saved, ...(recent ?? []).filter((q) => !saved.includes(q))], [saved, recent]);
  const toggle = (q: string) =>
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(q)) next.delete(q);
      else next.add(q);
      return next;
    });
  const addQuestion = () => {
    const q = extra.trim().slice(0, 300);
    if (!q || all.includes(q)) return;
    const next = [q, ...saved];
    setSaved(next);
    writeSaved(org.id, next);
    setPicked((p) => new Set(p).add(q));
    setExtra("");
  };
  const removeSaved = (q: string) => {
    const next = saved.filter((s) => s !== q);
    setSaved(next);
    writeSaved(org.id, next);
  };

  const unchanged = current !== null && draft.trim() === current.trim();
  const questions = all.filter((q) => picked.has(q));

  const run = async () => {
    if (busy || questions.length === 0 || !draft.trim()) return;
    setBusy(true);
    setRows(questions.map((question) => ({ question, current: null, draft: null })));
    const queue = [...questions];
    const worker = async () => {
      for (let q = queue.shift(); q !== undefined; q = queue.shift()) {
        const question = q;
        const row = await runBothSides(org.id, question, draft).catch((e: unknown) => ({
          question,
          current: null,
          draft: null,
          failed: e instanceof Error ? e.message : "Test failed.",
        }));
        setRows((rs) => rs.map((r) => (r.question === question ? row : r)));
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, questions.length) }, worker));
    setBusy(false);
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Each question runs twice through the Test path: with {org.name}'s saved "How I behave" instructions, and with your draft in their place. Nothing is sent, nothing is charged to the merchant, nothing is saved.
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <Label>Test questions ({questions.length} picked)</Label>
          <div className="flex gap-2">
            <Input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Add a question to keep for this workspace" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addQuestion(); } }} />
            <Button type="button" variant="outline" size="icon" onClick={addQuestion} aria-label="Add question" disabled={!extra.trim()}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          <div className="max-h-[320px] space-y-1 overflow-auto rounded-xl border border-border/70 p-2">
            {recent === null ? (
              Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-7 w-full rounded-lg" />)
            ) : all.length === 0 ? (
              <p className="py-4 text-center text-sm text-muted-foreground">No customer questions yet. Add your own above.</p>
            ) : (
              all.map((q) => (
                <label key={q} className="flex items-start gap-2 rounded-lg px-2 py-1 text-sm hover:bg-muted/50">
                  <Checkbox checked={picked.has(q)} onCheckedChange={() => toggle(q)} className="mt-0.5" />
                  <span className="flex-1">{q}</span>
                  {saved.includes(q) ? (
                    <button type="button" onClick={(e) => { e.preventDefault(); removeSaved(q); }} aria-label="Remove saved question" className="text-muted-foreground hover:text-destructive">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </label>
              ))
            )}
          </div>
          <p className="text-[11px] text-muted-foreground">The workspace's last 20 customer questions, plus the ones you added (kept in this browser).</p>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="compare-draft">Draft instructions</Label>
            {current !== null && !unchanged ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(current)}>Reset to saved</Button>
            ) : null}
          </div>
          <Textarea id="compare-draft" rows={12} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="The instructions to try instead of the saved ones." />
          <p className="text-[11px] text-muted-foreground">
            {unchanged ? "Same as the saved instructions — edit to see a difference." : "Only the instructions text changes; persona, tone, languages and hand-over rules stay as saved."}
          </p>
        </div>
      </div>
      <Button onClick={() => void run()} disabled={busy || questions.length === 0 || !draft.trim()}>
        <Columns2 className="mr-1 h-4 w-4" /> {busy ? "Running…" : `Compare ${questions.length} ${questions.length === 1 ? "question" : "questions"}`}
      </Button>

      {rows.length > 0 ? (
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.question} className="rounded-xl border border-border/70 p-3">
              <p className="mb-2 text-sm font-medium">“{r.question}”</p>
              {r.failed ? <p className="mb-2 text-xs text-destructive">{r.failed}</p> : null}
              <div className="grid gap-3 md:grid-cols-2">
                <Side title="Saved instructions" side={r.current} pending={busy && !r.current && !r.failed} />
                <Side title="Draft" side={r.draft} pending={busy && !r.draft && !r.failed} />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Side({ title, side, pending }: { title: string; side: SideRun | null; pending: boolean }) {
  return (
    <div className="rounded-lg bg-muted/30 p-2">
      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      {pending ? (
        <Skeleton className="h-16 w-full rounded-lg" />
      ) : !side ? (
        <p className="text-xs text-muted-foreground">No reply.</p>
      ) : (
        <>
          {side.sequence?.length ? <SendSequence steps={side.sequence} compact /> : <p className="whitespace-pre-wrap text-sm">{side.reply?.trim() ? side.reply : side.error ?? "No reply."}</p>}
          <div className="mt-2 flex flex-wrap gap-1 text-[11px] text-muted-foreground">
            <span className="rounded-full bg-muted px-2 py-0.5">{side.status}</span>
            {side.needs_owner ? <span className="rounded-full bg-primary/10 px-2 py-0.5 text-primary">would go to Unanswered</span> : null}
            {side.escalation ? <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-destructive">hand-over: {side.escalation}</span> : null}
            <span className="px-1">{(side.latency_ms / 1000).toFixed(1)}s</span>
          </div>
        </>
      )}
    </div>
  );
}
