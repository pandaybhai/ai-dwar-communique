import { useCallback, useRef, useState } from "react";
import {
  AlertCircle,
  BookOpen,
  FileSpreadsheet,
  FileText,
  Globe,
  Loader2,
  MessageCircleQuestion,
  RefreshCw,
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
import {
  knowledgeApi,
  whenText,
  type KnowledgeItem,
  type KnowledgeSource,
} from "@/lib/employee-client";

const ICONS = {
  website: Globe,
  pdf: FileText,
  spreadsheet: FileSpreadsheet,
  manual_qa: MessageCircleQuestion,
} as const;

const KIND_TEXT: Record<string, { label: string; live: boolean }> = {
  website: { label: "Website", live: true },
  pdf: { label: "PDF", live: false },
  spreadsheet: { label: "Spreadsheet", live: false },
  manual_qa: { label: "Written answers", live: false },
};

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

  const totalItems = sources.reduce((sum, s) => sum + (s.item_count ?? 0), 0);

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
      ) : sources.length === 0 ? (
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
          {sources.map((source) => {
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
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {kind.label} · {source.item_count.toLocaleString("en-IN")} items ·{" "}
                      {kind.live ? `re-read ${whenText(source.last_synced_at)}` : "read once"}
                    </p>
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
                  <Button size="sm" variant="ghost" onClick={() => setOpenSource(source)}>
                    See what it read
                  </Button>
                  {canConfigure && kind.live ? (
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
            {items.map((item) => (
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
