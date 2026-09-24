import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  BookOpen,
  FileSpreadsheet,
  FileText,
  Globe,
  HelpCircle,
  Loader2,
  MessageCircleQuestion,
  RefreshCw,
  BookOpenCheck,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { gapsChanged } from "@/hooks/use-pending-gaps";
import {
  knowledgeApi,
  whenText,
  type Gap,
  type KnowledgeItem,
  type KnowledgeSource,
} from "@/lib/employee-client";

const ICONS = {
  website: Globe,
  pdf: FileText,
  spreadsheet: FileSpreadsheet,
  manual_qa: MessageCircleQuestion,
  upload: FileText,
  image: FileText,
  docx: FileText,
} as const;

const KIND_TEXT: Record<string, { label: string; live: boolean }> = {
  website: { label: "Website", live: true },
  pdf: { label: "PDF", live: false },
  spreadsheet: { label: "Spreadsheet", live: false },
  manual_qa: { label: "Written answers", live: false },
  upload: { label: "Files you sent on chat", live: false },
  image: { label: "Photo", live: false },
  docx: { label: "Document", live: false },
};

/** Still working on it: queued to start, or reading right now. */
export function isReading(status: string): boolean {
  return status === "pending" || status === "queued" || status === "syncing";
}

const nf = (n: number) => n.toLocaleString("en-IN");

/** One plain line about where a source has got to. */
export function ReadingLine({ source }: { source: KnowledgeSource }) {
  const pages = source.pages_seen ?? 0;
  const items = source.item_count ?? 0;
  const products = source.products_found ?? 0;
  const noun = source.type === "website" ? "products" : "items";
  if (source.status === "queued") return <>Waiting to start</>;
  if (source.status === "pending") return <>Queued</>;
  if (source.status === "syncing") {
    return (
      <>
        Reading {source.name}
        {pages > 0 || items > 0 ? ` — ${nf(pages)} pages, ${nf(items)} so far` : " — just started"}
      </>
    );
  }
  const total = source.total_pages ?? 0;
  return (
    <>
      Read {nf(pages)}
      {source.type === "website" && total > pages ? ` of ${nf(total)}` : ""} pages
      {products > 0 ? ` · ${nf(products)} ${noun}` : ""} · updated {whenText(source.last_synced_at)}
    </>
  );
}

/** "Next: 40 more pages tonight · refreshes every 7 days" — parts that don't apply are hidden. */
export function NextLine({ source }: { source: KnowledgeSource }) {
  const r = source.reading;
  if (!r || isReading(source.status)) return null;
  const parts = [
    r.tonight > 0 ? `${nf(r.tonight)} more page${r.tonight === 1 ? "" : "s"} tonight` : null,
    r.refresh_days > 0 ? `refreshes every ${r.refresh_days} day${r.refresh_days === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  if (!parts.length) return null;
  return <p className="mt-0.5 text-xs text-muted-foreground">Next: {parts.join(" · ")}</p>;
}

/** A soft bar that says "working", never a fake percentage. */
export function ReadingBar() {
  return (
    <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-primary/10">
      <div className="h-full w-1/3 animate-[shimmer_1.6s_ease-in-out_infinite] rounded-full bg-primary/60" />
    </div>
  );
}

/**
 * What the AI employee has read. Live sources re-read themselves; uploads are
 * read once. Everything it knows is visible here and can be deleted.
 */
export function KnowledgeManager({
  organizationId,
  sources,
  loading,
  canConfigure,
  onChanged,
}: {
  organizationId: string;
  sources: KnowledgeSource[];
  loading: boolean;
  canConfigure: boolean;
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState<null | "website" | "file" | "answer">(null);
  const [openSource, setOpenSource] = useState<KnowledgeSource | null>(null);
  // While something is being read, refresh this list itself every 5s so the
  // owner watches it happen instead of pressing reload.
  const [live, setLive] = useState<KnowledgeSource[] | null>(null);
  useEffect(() => {
    setLive(null);
  }, [sources]);
  const rows = live ?? sources;
  const reading = rows.some((s) => isReading(s.status));
  useEffect(() => {
    if (!reading) return;
    let stopped = false;
    const id = setInterval(() => {
      void knowledgeApi<{ sources: KnowledgeSource[] }>({
        organization_id: organizationId,
        action: "list",
      }).then(({ data }) => {
        if (stopped || !data?.sources) return;
        setLive(data.sources);
        if (!data.sources.some((s) => isReading(s.status))) onChanged();
      });
    }, 5000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [reading, organizationId, onChanged]);


  const act = useCallback(
    async (body: Record<string, unknown>, id: string, success: string) => {
      setBusyId(id);
      const { error } = await knowledgeApi({ organization_id: organizationId, ...body });
      setBusyId(null);
      if (error) toast.error(error);
      else {
        toast.success(success);
        onChanged();
      }
    },
    [organizationId, onChanged],
  );

  const totalItems = rows.reduce((sum, s) => sum + (s.item_count ?? 0), 0);

  return (
    <section aria-labelledby="knowledge-heading" className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 id="knowledge-heading" className="text-lg font-semibold text-foreground">
            What it knows
          </h2>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            {totalItems > 0
              ? `${totalItems.toLocaleString("en-IN")} things it has read. It answers from these — and says it doesn't know when the answer isn't here.`
              : "Give it something to read. Until then it will pass every question to your team."}
          </p>
        </div>
        {canConfigure ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setAddOpen("website")}>
              <Globe className="mr-2 h-4 w-4" aria-hidden="true" />
              Add a website
            </Button>
            <Button size="sm" variant="outline" onClick={() => setAddOpen("file")}>
              <FileText className="mr-2 h-4 w-4" aria-hidden="true" />
              Upload a file
            </Button>
            <Button size="sm" variant="outline" onClick={() => setAddOpen("answer")}>
              <MessageCircleQuestion className="mr-2 h-4 w-4" aria-hidden="true" />
              Write an answer
            </Button>
          </div>
        ) : null}
      </div>

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32 rounded-2xl" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="It hasn't read anything yet"
          description="Point it at your website and it will learn your products, shipping and returns in about a minute."
          action={
            canConfigure ? (
              <Button onClick={() => setAddOpen("website")}>Add your website</Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {rows.map((source) => {
            const Icon = ICONS[source.type as keyof typeof ICONS] ?? BookOpen;
            const kind = KIND_TEXT[source.type] ?? { label: source.type, live: false };
            const busy = busyId === source.id;
            return (
              <li
                key={source.id}
                className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm transition-shadow duration-200 hover:shadow-md"
              >
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-foreground">{source.name}</p>
                    {kind.live ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        <ReadingLine source={source} />
                        {source.config?.["platform"] ? (
                          <Badge variant="outline" className="ml-2 capitalize">
                            {String(source.config["platform"])}
                          </Badge>
                        ) : null}
                      </p>
                    ) : (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {kind.label} · {source.item_count.toLocaleString("en-IN")} items · read once
                      </p>
                    )}
                    {source.type === "website" ? <NextLine source={source} /> : null}
                    {source.type === "website" && isReading(source.status) ? <ReadingBar /> : null}
                  </div>
                  <Badge variant={source.status === "error" ? "destructive" : "secondary"}>
                    {source.status === "ready"
                      ? kind.live
                        ? "Live"
                        : "Saved"
                      : source.status === "error"
                        ? "Needs attention"
                        : "Reading"}
                  </Badge>
                </div>

                {source.last_error ? (
                  <p className="mt-3 flex items-start gap-2 rounded-lg bg-destructive/5 p-2 text-xs text-destructive">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    {source.last_error}
                  </p>
                ) : null}

                <div className="mt-4 flex flex-wrap gap-2">
                  {source.status === "error" && canConfigure ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        act({ action: "sync", source_id: source.id }, source.id, "Trying again.")
                      }
                    >
                      <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
                      Retry
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={() => setOpenSource(source)}>
                    See what it read
                  </Button>
                  {canConfigure && source.type === "website" && source.reading && !isReading(source.status) ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy || Boolean(source.reading.changes_available_at)}
                        title={source.reading.changes_available_at ? `Available ${new Date(source.reading.changes_available_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}` : undefined}
                        onClick={() => act({ action: "read_changes", source_id: source.id }, source.id, "Checking for changes.")}
                      >
                        <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
                        {source.reading.changes_available_at
                          ? `Read changes · ${new Date(source.reading.changes_available_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}`
                          : "Read changes now"}
                      </Button>
                      {source.reading.can_read_more ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => act({ action: "read_more", source_id: source.id }, source.id, "Reading more pages.")}
                        >
                          <BookOpenCheck className="mr-2 h-4 w-4" aria-hidden="true" />
                          Read more pages now
                        </Button>
                      ) : source.reading.unread > 0 ? (
                        <Button size="sm" variant="ghost" asChild>
                          <Link to="/app/billing">
                            Upgrade to read all {nf((source.total_pages ?? 0) || (source.pages_seen ?? 0) + source.reading.unread)} pages
                          </Link>
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                  {canConfigure && kind.live && source.type !== "website" ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => act({ action: "sync", source_id: source.id }, source.id, "Re-read.")}
                    >
                      {busy ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
                      )}
                      Re-read now
                    </Button>
                  ) : null}
                  {canConfigure ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      disabled={busy}
                      onClick={() =>
                        act({ action: "delete_source", source_id: source.id }, source.id, "Forgotten.")
                      }
                    >
                      <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
                      Make it forget
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <AddDialog
        kind={addOpen}
        organizationId={organizationId}
        onClose={() => setAddOpen(null)}
        onAdded={onChanged}
      />
      <SourceItemsDialog
        organizationId={organizationId}
        source={openSource}
        canConfigure={canConfigure}
        onClose={() => setOpenSource(null)}
        onChanged={onChanged}
      />
    </section>
  );
}

function AddDialog({
  kind,
  organizationId,
  onClose,
  onAdded,
}: {
  kind: null | "website" | "file" | "answer";
  organizationId: string;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [url, setUrl] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setUrl("");
    setQuestion("");
    setAnswer("");
    setSaving(false);
  };

  const submit = async () => {
    setSaving(true);
    let body: Record<string, unknown> | null = null;

    if (kind === "website") {
      body = { action: "add_website", url: url.trim() };
    } else if (kind === "answer") {
      body = { action: "add_answer", question: question.trim(), answer: answer.trim() };
    } else if (kind === "file") {
      const file = fileRef.current?.files?.[0];
      if (!file) {
        setSaving(false);
        toast.error("Choose a file first.");
        return;
      }
      if (file.size > 8 * 1024 * 1024) {
        setSaving(false);
        toast.error("That file is larger than 8 MB. Split it and try again.");
        return;
      }
      const buffer = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < buffer.length; i += 1) binary += String.fromCharCode(buffer[i]!);
      body = {
        action: "add_file",
        file_name: file.name,
        kind: file.name.toLowerCase().endsWith(".pdf") ? "pdf" : "spreadsheet",
        file_base64: btoa(binary),
      };
    }

    if (!body) return;
    const { data, error } = await knowledgeApi<{ itemCount?: number; error?: string }>({
      organization_id: organizationId,
      ...body,
    });
    setSaving(false);
    if (error) {
      toast.error(error);
      return;
    }
    if (data && data.error) toast.warning(data.error);
    else toast.success(`Read and remembered${data?.itemCount ? ` — ${data.itemCount} items` : ""}.`);
    reset();
    onAdded();
    onClose();
  };

  return (
    <Dialog
      open={kind !== null}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {kind === "website"
              ? "Add a website"
              : kind === "file"
                ? "Upload a file"
                : "Write an answer yourself"}
          </DialogTitle>
          <DialogDescription>
            {kind === "website"
              ? "It reads up to 40 pages and checks back every week, so price and policy changes look after themselves."
              : kind === "file"
                ? "A PDF or a spreadsheet — a price list, a policy, an FAQ. We keep the text, not the file."
                : "The exact wording you want a customer to hear. Your words always win over anything it read."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {kind === "website" ? (
            <div className="space-y-2">
              <Label htmlFor="k-url">Web address</Label>
              <Input
                id="k-url"
                placeholder="https://yourstore.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                autoFocus
              />
            </div>
          ) : null}

          {kind === "file" ? (
            <div className="space-y-2">
              <Label htmlFor="k-file">File</Label>
              <Input id="k-file" type="file" ref={fileRef} accept=".pdf,.csv,.xlsx,.xls" />
              <p className="text-xs text-muted-foreground">PDF, CSV or Excel, up to 8 MB.</p>
            </div>
          ) : null}

          {kind === "answer" ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="k-q">When a customer asks…</Label>
                <Input
                  id="k-q"
                  placeholder="Do you deliver to Nagpur?"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="k-a">…say this</Label>
                <Textarea
                  id="k-a"
                  rows={4}
                  placeholder="Yes — Nagpur delivery takes 3–4 working days and is free above ₹999."
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                />
              </div>
            </>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {saving ? "Reading…" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SourceItemsDialog({
  organizationId,
  source,
  canConfigure,
  onClose,
  onChanged,
}: {
  organizationId: string;
  source: KnowledgeSource | null;
  canConfigure: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<KnowledgeItem[] | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  if (source && loadedFor !== source.id) {
    setLoadedFor(source.id);
    setItems(null);
    void knowledgeApi<{ documents: KnowledgeItem[] }>({
      organization_id: organizationId,
      action: "open",
      source_id: source.id,
    }).then(({ data }) => setItems(data?.documents ?? []));
  }

  return (
    <Dialog
      open={source !== null}
      onOpenChange={(open) => {
        if (!open) {
          setLoadedFor(null);
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{source?.name}</DialogTitle>
          <DialogDescription>
            Exactly what it read here. Delete anything that is out of date or shouldn't be said.
          </DialogDescription>
        </DialogHeader>

        {items === null ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-16 rounded-xl" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Nothing readable was found here.
          </p>
        ) : (
          <ul className="space-y-3">
            {(() => {
              const products = items.filter((i) => /\/products\//.test(i.source_ref ?? ""));
              return products.length > 1 ? (
                <li className="rounded-xl border border-border/70 bg-muted/30 p-4">
                  <p className="text-sm font-medium text-foreground">
                    Products · {products.length.toLocaleString("en-IN")}
                  </p>
                  <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                    {products
                      .slice(0, 12)
                      .map((p) => p.title)
                      .join(", ")}
                  </p>
                </li>
              ) : null;
            })()}
            {items
              .filter(
                (item) =>
                  !/\/products\//.test(item.source_ref ?? "") ||
                  items.filter((i) => /\/products\//.test(i.source_ref ?? "")).length <= 1,
              )
              .map((item) => (
              <li key={item.id} className="rounded-xl border border-border/70 bg-muted/30 p-4">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-medium text-foreground">{item.title}</p>
                  {canConfigure ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-destructive hover:text-destructive"
                      onClick={async () => {
                        await knowledgeApi({
                          organization_id: organizationId,
                          action: "delete_document",
                          document_id: item.id,
                        });
                        setItems((prev) => (prev ?? []).filter((d) => d.id !== item.id));
                        onChanged();
                      }}
                    >
                      Delete
                    </Button>
                  ) : null}
                </div>
                <p className="mt-1 line-clamp-4 text-xs leading-relaxed text-muted-foreground">
                  {item.content}
                </p>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Questions I couldn't answer. Write the answer here and the customer gets it
 * now — and I remember it for good. Answering on WhatsApp clears it too.
 */
export function UnansweredList({
  organizationId,
  canConfigure,
  onChanged,
}: {
  organizationId: string;
  canConfigure: boolean;
  onChanged: () => void;
}) {
  const [gaps, setGaps] = useState<Gap[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await knowledgeApi<{ gaps: Gap[]; total: number }>({
      organization_id: organizationId,
      action: "gaps",
      page,
    });
    if (error) toast.error(error);
    setGaps(data?.gaps ?? []);
    setTotal(data?.total ?? 0);
  }, [organizationId, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const teach = async (gap: Gap) => {
    const answer = (drafts[gap.id] ?? "").trim();
    if (!answer) {
      toast.error("Write the answer first.");
      return;
    }
    setBusyId(gap.id);
    const { data, error } = await knowledgeApi<{ delivered?: boolean }>({
      organization_id: organizationId,
      action: "answer_gap",
      reply_id: gap.id,
      answer,
    });
    setBusyId(null);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success(
      data?.delivered
        ? "Sent to the customer — and I'll remember it."
        : "Saved — customer's window has closed, they'll get it next time they write.",
    );
    setDrafts((d) => ({ ...d, [gap.id]: "" }));
    gapsChanged();
    await load();
    onChanged();
  };

  const dismiss = async (gap: Gap) => {
    setBusyId(gap.id);
    const { error } = await knowledgeApi({
      organization_id: organizationId,
      action: "dismiss_gap",
      reply_id: gap.id,
    });
    setBusyId(null);
    if (error) {
      toast.error(error);
      return;
    }
    gapsChanged();
    await load();
  };

  if (gaps === null) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
      </div>
    );
  }

  if (gaps.length === 0) {
    return (
      <EmptyState
        icon={HelpCircle}
        title="Nothing waiting"
        description="Nothing waiting. When I can't answer a customer, it lands here."
      />
    );
  }

  const pages = Math.max(1, Math.ceil(total / 20));

  return (
    <section aria-labelledby="unanswered-heading" className="space-y-4">
      <div>
        <h2 id="unanswered-heading" className="text-lg font-semibold text-foreground">
          Questions I couldn't answer
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Write the answer once. If the customer's chat is still open I'll send it straight away.
        </p>
      </div>

      <ul className="space-y-3">
        {gaps.map((gap) => {
          const busy = busyId === gap.id;
          return (
            <li key={gap.id} className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <p className="min-w-0 text-sm font-medium text-foreground">{gap.question}</p>
                <Badge variant={gap.status === "pending" ? "default" : "secondary"}>
                  {gap.status === "pending" ? "Waiting" : "Expired"}
                </Badge>
              </div>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>Asked {whenText(gap.created_at)}</span>
                <span>· {gap.conversation_id ? "Customer on WhatsApp" : "Your test chat"}</span>
                {gap.conversation_id ? (
                  <a
                    className="text-primary underline-offset-4 hover:underline"
                    href={`/app/inbox?c=${gap.conversation_id}`}
                  >
                    Open thread
                  </a>
                ) : null}
              </p>

              {canConfigure ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Input
                    aria-label={`Answer for: ${gap.question}`}
                    className="min-w-[12rem] flex-1"
                    placeholder="The answer, the way you'd say it."
                    value={drafts[gap.id] ?? ""}
                    onChange={(e) => setDrafts((d) => ({ ...d, [gap.id]: e.target.value }))}
                  />
                  <Button size="sm" disabled={busy} onClick={() => void teach(gap)}>
                    {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    Teach
                  </Button>
                  {gap.status === "pending" ? (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void dismiss(gap)}>
                      Dismiss
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {pages > 1 ? (
        <div className="flex items-center gap-3">
          <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span className="text-xs text-muted-foreground">
            Page {page + 1} of {pages}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={page + 1 >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      ) : null}
    </section>
  );
}
