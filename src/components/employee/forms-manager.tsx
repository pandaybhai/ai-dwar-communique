import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ClipboardList,
  Copy,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useWhatsAppNumbers } from "@/hooks/use-whatsapp-numbers";
import { callApi } from "@/lib/whatsapp-client";
import { plural } from "@/lib/plural";
import {
  FIELD_TYPES,
  STARTER_FORMS,
  fieldHasOptions,
  fieldKey,
  readableAnswers,
  validateForm,
  type FormField,
  type FormFieldType,
  type FormRow,
} from "@/lib/wa-forms";

type Draft = {
  id?: string;
  name: string;
  purpose: string | null;
  cta: string;
  intro: string;
  whatsapp_account_id: string | null;
  fields: FormField[];
};

type ResponseRow = {
  id: string;
  form_id: string | null;
  answers: Record<string, unknown>;
  received_at: string;
  contacts: { name: string | null; phone: string } | null;
};

const STATUS_LABEL: Record<FormRow["status"], string> = {
  draft: "Draft",
  published: "Live",
  deprecated: "Retired",
  error: "Needs fixing",
};

export function FormsManager({
  organizationId,
  canConfigure,
}: {
  organizationId: string;
  canConfigure: boolean;
}) {
  const { numbers, defaultNumber } = useWhatsAppNumbers();
  const [forms, setForms] = useState<FormRow[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [responsesFor, setResponsesFor] = useState<FormRow | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const { data, error: err } = await callApi<{ forms: FormRow[]; response_counts: Record<string, number> }>(
      "/api/forms",
      { body: { action: "list", organization_id: organizationId } },
    );
    if (err || !data) {
      setError(err ?? "We couldn't load your forms. Please refresh.");
      setForms([]);
      return;
    }
    setForms(data.forms);
    setCounts(data.response_counts ?? {});
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const startFrom = (starter?: (typeof STARTER_FORMS)[number]) =>
    setDraft({
      name: starter?.name ?? "",
      purpose: starter?.purpose ?? null,
      cta: starter?.cta ?? "Open form",
      intro: starter?.intro ?? "",
      whatsapp_account_id: defaultNumber?.id ?? null,
      fields: starter ? starter.fields.map((f) => ({ ...f })) : [],
    });

  const edit = (f: FormRow) =>
    setDraft({
      id: f.id,
      name: f.name,
      purpose: f.purpose,
      cta: f.cta,
      intro: f.intro ?? "",
      whatsapp_account_id: f.whatsapp_account_id,
      fields: f.fields.map((x) => ({ ...x })),
    });

  const save = async (): Promise<string | null> => {
    if (!draft) return null;
    const problem = validateForm(draft);
    if (problem) {
      toast.error(problem);
      return null;
    }
    setBusy("save");
    const { data, error: err } = await callApi<{ id: string; new_version?: boolean }>("/api/forms", {
      body: { action: "save", organization_id: organizationId, ...draft },
    });
    setBusy(null);
    if (err || !data) {
      toast.error(err ?? "Couldn't save the form.");
      return null;
    }
    toast.success(data.new_version ? "Saved as a new draft version — the live one keeps working." : "Form saved.");
    setDraft({ ...draft, id: data.id });
    await load();
    return data.id;
  };

  const publish = async (id: string) => {
    setBusy(`publish:${id}`);
    const { data, error: err } = await callApi<{ ok: boolean; error?: string }>("/api/forms", {
      body: { action: "publish", organization_id: organizationId, id },
    });
    setBusy(null);
    if (data?.ok) toast.success("Form is live on WhatsApp.");
    else toast.error("WhatsApp didn't accept the form — see the details on the form.");
    void err;
    await load();
  };

  const remove = async (f: FormRow) => {
    setBusy(`delete:${f.id}`);
    const { error: err } = await callApi("/api/forms", {
      body: { action: "delete", organization_id: organizationId, id: f.id },
    });
    setBusy(null);
    if (err) toast.error(err);
    else toast.success(f.status === "published" ? "Form retired." : "Form deleted.");
    await load();
  };

  if (forms === null) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full rounded-2xl" />
        <Skeleton className="h-24 w-full rounded-2xl" />
      </div>
    );
  }

  if (draft) {
    return (
      <FormBuilder
        draft={draft}
        numbers={numbers.map((n) => ({ id: n.id, label: n.display_phone_number ?? n.verified_name ?? "Number" }))}
        busy={busy}
        canConfigure={canConfigure}
        lastError={forms.find((f) => f.id === draft.id)?.last_error ?? null}
        onChange={setDraft}
        onCancel={() => setDraft(null)}
        onSave={save}
        onPublish={async () => {
          const id = await save();
          if (id) await publish(id);
        }}
      />
    );
  }

  if (responsesFor) {
    return (
      <Responses organizationId={organizationId} form={responsesFor} onBack={() => setResponsesFor(null)} />
    );
  }

  return (
    <div className="space-y-6">
      {error ? <ErrorState message={error} /> : null}

      {canConfigure ? (
        <section className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
          <h3 className="font-display text-base font-semibold">Start a new form</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Customers fill these in without leaving WhatsApp. Pick a starter or build your own.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {STARTER_FORMS.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => startFrom(s)}
                className="rounded-xl border border-border/70 bg-background p-3 text-left text-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-sm"
              >
                <span className="font-medium">{s.name}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {plural(s.fields.length, "question")}
                </span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => startFrom()}
              className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border p-3 text-sm text-muted-foreground transition-colors duration-200 hover:border-primary/50 hover:text-foreground"
            >
              <Plus className="h-4 w-4" /> Blank form
            </button>
          </div>
        </section>
      ) : null}

      {forms.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No forms yet"
          description="Build a booking, order or feedback form and send it in any chat."
          action={
            canConfigure ? (
              <Button className="rounded-full" onClick={() => startFrom(STARTER_FORMS[0])}>
                Start with “Book an appointment”
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-3">
          {forms.map((f) => (
            <article key={f.id} className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-display text-base font-semibold">{f.name}</h3>
                    <Badge variant={f.status === "published" ? "default" : "secondary"}>
                      {STATUS_LABEL[f.status]}
                    </Badge>
                    {f.version > 1 ? <span className="text-xs text-muted-foreground">v{f.version}</span> : null}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {plural(f.fields.length, "question")} · {plural(counts[f.id] ?? 0, "answer")}
                  </p>
                  {f.meta_flow_id && f.status === "published" ? (
                    <button
                      type="button"
                      className="mt-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        void navigator.clipboard.writeText(f.meta_flow_id ?? "");
                        toast.success("Form ID copied — paste it into a template's “Open a form” button.");
                      }}
                    >
                      <Copy className="h-3 w-3" /> Form ID {f.meta_flow_id} (for template buttons)
                    </button>
                  ) : null}
                  {f.status === "error" && f.last_error ? (
                    <p className="mt-2 flex items-start gap-1.5 whitespace-pre-wrap text-sm text-destructive">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      {f.last_error}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" className="rounded-full" onClick={() => setResponsesFor(f)}>
                    Answers
                  </Button>
                  {canConfigure ? (
                    <>
                      <Button variant="outline" size="sm" className="rounded-full" onClick={() => edit(f)}>
                        {f.status === "published" ? "Change (new version)" : "Edit"}
                      </Button>
                      {f.status !== "published" ? (
                        <Button
                          size="sm"
                          className="rounded-full"
                          disabled={busy !== null}
                          onClick={() => void publish(f.id)}
                        >
                          {busy === `publish:${f.id}` ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                          Publish
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="rounded-full"
                        disabled={busy !== null}
                        onClick={() => void remove(f)}
                        aria-label={f.status === "published" ? "Retire form" : "Delete form"}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Forms sent within 24 hours of the customer's last message are free. After that, send an approved
        template with an “Open a form” button using the Form ID above.
      </p>
    </div>
  );
}

function FormBuilder({
  draft,
  numbers,
  busy,
  canConfigure,
  lastError,
  onChange,
  onCancel,
  onSave,
  onPublish,
}: {
  draft: Draft;
  numbers: { id: string; label: string }[];
  busy: string | null;
  canConfigure: boolean;
  lastError: string | null;
  onChange: (d: Draft) => void;
  onCancel: () => void;
  onSave: () => Promise<string | null>;
  onPublish: () => Promise<void>;
}) {
  const problem = useMemo(() => validateForm(draft), [draft]);
  const setField = (i: number, patch: Partial<FormField>) =>
    onChange({ ...draft, fields: draft.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  const move = (i: number, d: -1 | 1) => {
    const next = [...draft.fields];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange({ ...draft, fields: next });
  };
  const addField = () => {
    const taken = new Set(draft.fields.map((f) => f.key));
    onChange({
      ...draft,
      fields: [...draft.fields, { key: fieldKey("question", taken), type: "text", label: "", required: false }],
    });
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <section className="space-y-5 rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="form-name">Form name</Label>
            <Input id="form-name" value={draft.name} maxLength={60} onChange={(e) => onChange({ ...draft, name: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="form-cta">Button text</Label>
            <Input id="form-cta" value={draft.cta} maxLength={20} onChange={(e) => onChange({ ...draft, cta: e.target.value })} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="form-intro">Message above the button</Label>
            <Textarea id="form-intro" value={draft.intro} maxLength={1000} rows={2} onChange={(e) => onChange({ ...draft, intro: e.target.value })} />
          </div>
          {numbers.length > 1 ? (
            <div className="space-y-1.5">
              <Label>Publish on</Label>
              <Select
                value={draft.whatsapp_account_id ?? ""}
                onValueChange={(v) => onChange({ ...draft, whatsapp_account_id: v })}
              >
                <SelectTrigger><SelectValue placeholder="Choose a number" /></SelectTrigger>
                <SelectContent>
                  {numbers.map((n) => (
                    <SelectItem key={n.id} value={n.id}>{n.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>

        <div className="space-y-3">
          <h3 className="font-display text-sm font-semibold">Questions</h3>
          {draft.fields.length === 0 ? (
            <p className="rounded-xl bg-muted/40 p-4 text-sm text-muted-foreground">No questions yet — add the first one.</p>
          ) : null}
          {draft.fields.map((f, i) => (
            <div key={i} className="space-y-3 rounded-xl border border-border/60 bg-background p-4">
              <div className="grid gap-3 sm:grid-cols-[1fr_170px]">
                <Input
                  aria-label="Question label"
                  placeholder="Question"
                  value={f.label}
                  maxLength={f.type === "opt_in" ? 120 : 30}
                  onChange={(e) => {
                    const label = e.target.value;
                    const taken = new Set(draft.fields.filter((_, j) => j !== i).map((x) => x.key));
                    setField(i, { label, key: fieldKey(label || "question", taken) });
                  }}
                />
                <Select value={f.type} onValueChange={(v) => setField(i, { type: v as FormFieldType })}>
                  <SelectTrigger aria-label="Question type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {FIELD_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {fieldHasOptions(f.type) ? (
                <Textarea
                  aria-label="Choices, one per line"
                  placeholder="Choices, one per line"
                  rows={3}
                  value={(f.options ?? []).join("\n")}
                  onChange={(e) => setField(i, { options: e.target.value.split("\n") })}
                />
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <Input
                  aria-label="Helper text"
                  placeholder="Helper text (optional)"
                  maxLength={80}
                  value={f.helper ?? ""}
                  onChange={(e) => setField(i, { helper: e.target.value })}
                />
                <Select
                  value={f.map_to || "none"}
                  onValueChange={(v) => setField(i, { map_to: (v === "none" ? "" : v) as NonNullable<FormField["map_to"]> })}
                >
                  <SelectTrigger aria-label="Save answer to contact"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Don't save to contact</SelectItem>
                    <SelectItem value="name">Save as contact name</SelectItem>
                    <SelectItem value="email">Save as email</SelectItem>
                    <SelectItem value="pincode">Save as pincode</SelectItem>
                    <SelectItem value="phone">Save as phone</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={f.required} onCheckedChange={(v) => setField(i, { required: v })} />
                  Required
                </label>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" aria-label="Move up" onClick={() => move(i, -1)}><ArrowUp className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="icon" aria-label="Move down" onClick={() => move(i, 1)}><ArrowDown className="h-4 w-4" /></Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remove question"
                    onClick={() => onChange({ ...draft, fields: draft.fields.filter((_, j) => j !== i) })}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
          <Button variant="outline" className="rounded-full" onClick={addField} disabled={draft.fields.length >= 20}>
            <Plus className="mr-1 h-4 w-4" /> Add question
          </Button>
        </div>

        {lastError ? (
          <p className="flex items-start gap-1.5 whitespace-pre-wrap rounded-xl bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            WhatsApp said: {lastError}
          </p>
        ) : null}
        {problem ? <p className="text-sm text-muted-foreground">{problem}</p> : null}

        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" className="rounded-full" onClick={onCancel}>Back</Button>
          <Button variant="outline" className="rounded-full" disabled={!canConfigure || busy !== null || Boolean(problem)} onClick={() => void onSave()}>
            {busy === "save" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            Save draft
          </Button>
          <Button className="rounded-full" disabled={!canConfigure || busy !== null || Boolean(problem)} onClick={() => void onPublish()}>
            {busy?.startsWith("publish") ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1 h-4 w-4" />}
            Save &amp; publish
          </Button>
        </div>
      </section>

      <FormPreview draft={draft} />
    </div>
  );
}

/** How the form looks on the customer's phone. */
function FormPreview({ draft }: { draft: Draft }) {
  return (
    <aside className="space-y-3 lg:sticky lg:top-4 lg:self-start">
      <p className="text-xs font-medium text-muted-foreground">Preview</p>
      <div className="rounded-[28px] border border-border bg-muted/40 p-3 shadow-sm">
        <div className="rounded-2xl rounded-bl-md border border-border/70 bg-card p-3 text-sm shadow-sm">
          <p className="font-semibold">{draft.name || "Form name"}</p>
          <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{draft.intro || "Your message here."}</p>
          <div className="mt-3 border-t border-border/70 pt-2 text-center font-medium text-primary">
            {draft.cta || "Open form"}
          </div>
        </div>
        <div className="mt-3 space-y-3 rounded-2xl bg-card p-4 text-sm">
          <p className="font-semibold">{draft.name || "Form"}</p>
          {draft.fields.map((f, i) => (
            <div key={i}>
              {f.type === "opt_in" ? (
                <p className="flex items-start gap-2"><span className="mt-0.5 h-4 w-4 shrink-0 rounded border border-border" />{f.label || "Agreement"}</p>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">{f.label || "Question"}{f.required ? "" : " (optional)"}</p>
                  {fieldHasOptions(f.type) ? (
                    <div className="mt-1 space-y-1">
                      {(f.options ?? []).filter((o) => o.trim()).slice(0, 5).map((o) => (
                        <p key={o} className="flex items-center gap-2">
                          <span className={`h-3.5 w-3.5 border border-border ${f.type === "checkbox" ? "rounded" : "rounded-full"}`} />
                          {o}
                        </p>
                      ))}
                    </div>
                  ) : (
                    <div className={`mt-1 rounded-lg border border-border ${f.type === "long_text" ? "h-14" : "h-8"}`} />
                  )}
                  {f.helper ? <p className="mt-0.5 text-[11px] text-muted-foreground">{f.helper}</p> : null}
                </>
              )}
            </div>
          ))}
          <div className="rounded-full bg-primary py-2 text-center text-xs font-semibold text-primary-foreground">Submit</div>
        </div>
      </div>
    </aside>
  );
}

function Responses({
  organizationId,
  form,
  onBack,
}: {
  organizationId: string;
  form: FormRow;
  onBack: () => void;
}) {
  const [rows, setRows] = useState<ResponseRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void callApi<{ responses: ResponseRow[] }>("/api/forms", {
      body: { action: "responses", organization_id: organizationId, id: form.id },
    }).then(({ data, error: err }) => {
      if (err) setError(err);
      setRows(data?.responses ?? []);
    });
  }, [organizationId, form.id]);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-base font-semibold">Answers to “{form.name}”</h3>
        <Button variant="ghost" className="rounded-full" onClick={onBack}>Back</Button>
      </div>
      {error ? <ErrorState message={error} /> : null}
      {rows === null ? (
        <Skeleton className="h-32 w-full rounded-2xl" />
      ) : rows.length === 0 ? (
        <EmptyState icon={ClipboardList} title="No answers yet" description="Send this form in a chat — answers show up here and in the inbox." />
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <article key={r.id} className="rounded-2xl border border-border/70 bg-card p-4 text-sm shadow-sm">
              <p className="font-medium">
                {r.contacts?.name || r.contacts?.phone || "Customer"}
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  {new Date(r.received_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}
                </span>
              </p>
              <dl className="mt-2 grid gap-1 sm:grid-cols-2">
                {readableAnswers(form.fields, r.answers).map((a) => (
                  <div key={a.key} className="flex gap-2">
                    <dt className="text-muted-foreground">{a.label}:</dt>
                    <dd className="font-medium">{a.value}</dd>
                  </div>
                ))}
              </dl>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
