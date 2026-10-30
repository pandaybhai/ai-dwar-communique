import { useCallback, useEffect, useId, useState, type CSSProperties } from "react";
import { Loader2, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { SupabaseClient } from "@supabase/supabase-js";
import { aidwar } from "@/integrations/aidwar/client";
import { logActivity } from "@/lib/activity";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { notesCopy as t } from "./copy";

/**
 * Batch 51: notes on a customer, in the new design's customer drawer. A note
 * is a teammate's own words with who wrote it and when (contact_notes,
 * 20261250, read and written through the member's RLS-scoped client; the
 * policies say who may). Adding and deleting are logged in the activity log,
 * without the note's words. Aiden doesn't read notes. Above them, Aiden's
 * last "Catch me up" summary of this customer's chat, only when one was
 * already written in the Inbox: nothing here asks Aiden for anything.
 */

export type Note = {
  id: string;
  body: string;
  author_id: string | null;
  created_at: string;
};

type Summary = { output: string; created_at: string };

export const NOTE_MAX = 2000;

/** Who may write a note: someone who edits contacts or replies to customers. */
export function canWriteNotes(can: (key: string) => boolean): boolean {
  return can("contacts.edit") || can("inbox.reply");
}

/** The insert for a new note: the workspace, the customer, the writer, the words. */
export function noteInsert(args: {
  organizationId: string;
  contactId: string;
  userId: string;
  body: string;
}) {
  return {
    organization_id: args.organizationId,
    contact_id: args.contactId,
    author_id: args.userId,
    body: args.body.trim().slice(0, NOTE_MAX),
  };
}

const missingTable = (code: string | undefined) => code === "PGRST205" || code === "42P01";

type Db = Pick<SupabaseClient, "from">;
type Log = typeof logActivity;

/** Saves a note as the signed-in teammate and logs it (never the words). */
export async function addNote(
  db: Db,
  log: Log,
  args: { organizationId: string; contactId: string; userId: string; body: string },
): Promise<{ note: Note } | { error: string }> {
  if (!args.body.trim()) return { error: t.writeFirst };
  const { data, error } = await db
    .from("contact_notes")
    .insert(noteInsert(args))
    .select("id, body, author_id, created_at")
    .single();
  if (error || !data)
    return {
      error: missingTable(error?.code) ? t.notOn : t.saveFailed,
    };
  const note = data as Note;
  void log("contact_note_added", args.organizationId, {
    contact_id: args.contactId,
    note_id: note.id,
  });
  return { note };
}

/** Deletes the teammate's own note (RLS allows no other) and logs it. */
export async function deleteNote(
  db: Db,
  log: Log,
  args: { organizationId: string; contactId: string; userId: string; noteId: string },
): Promise<{ ok: true } | { error: string }> {
  const { error } = await db
    .from("contact_notes")
    .delete()
    .eq("id", args.noteId)
    .eq("organization_id", args.organizationId)
    .eq("author_id", args.userId);
  if (error) return { error: t.deleteFailed };
  void log("contact_note_deleted", args.organizationId, {
    contact_id: args.contactId,
    note_id: args.noteId,
  });
  return { ok: true };
}

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export function CustomerNotes({
  organizationId,
  contactId,
  canWrite,
}: {
  organizationId: string;
  contactId: string;
  canWrite: boolean;
}) {
  const fieldId = useId();
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [state, setState] = useState<"ready" | "unavailable" | "error">("ready");
  const [names, setNames] = useState<Record<string, string>>({});
  const [me, setMe] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [{ data: who }, notesRes, summaryRes] = await Promise.all([
      aidwar.auth.getUser(),
      aidwar
        .from("contact_notes")
        .select("id, body, author_id, created_at")
        .eq("organization_id", organizationId)
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false })
        .limit(50),
      // Only a summary a teammate already asked for ("Catch me up" in the Inbox).
      aidwar
        .from("ai_runs")
        .select("output, created_at")
        .eq("organization_id", organizationId)
        .eq("contact_id", contactId)
        .eq("task", "summarise")
        .eq("status", "ok")
        .not("user_id", "is", null)
        .not("conversation_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    setMe(who.user?.id ?? null);
    const s = summaryRes.error ? null : (summaryRes.data as Summary | null);
    setSummary(s && s.output?.trim() ? s : null);
    if (notesRes.error) {
      setState(missingTable(notesRes.error.code) ? "unavailable" : "error");
      setNotes([]);
      return;
    }
    setState("ready");
    const rows = (notesRes.data ?? []) as Note[];
    setNotes(rows);
    const ids = Array.from(new Set(rows.map((n) => n.author_id).filter(Boolean))) as string[];
    if (ids.length) {
      const { data: profiles } = await aidwar
        .from("profiles")
        .select("id, full_name, email")
        .in("id", ids);
      const map: Record<string, string> = {};
      for (const p of (profiles ?? []) as Array<{
        id: string;
        full_name: string | null;
        email: string | null;
      }>)
        map[p.id] = p.full_name?.trim() || p.email || t.teammate;
      setNames(map);
    }
  }, [organizationId, contactId]);

  useEffect(() => {
    setNotes(null);
    setDraft("");
    void load();
  }, [load]);

  const add = async () => {
    if (!me || busy) return;
    setBusy(true);
    const res = await addNote(aidwar, logActivity, {
      organizationId,
      contactId,
      userId: me,
      body: draft,
    });
    setBusy(false);
    if ("error" in res) {
      toast.error(res.error);
      return;
    }
    setNotes((prev) => [res.note, ...(prev ?? [])]);
    setDraft("");
  };

  const remove = async (note: Note) => {
    if (!me) return;
    setBusy(true);
    const res = await deleteNote(aidwar, logActivity, {
      organizationId,
      contactId,
      userId: me,
      noteId: note.id,
    });
    setBusy(false);
    if ("error" in res) {
      toast.error(res.error);
      return;
    }
    setNotes((prev) => (prev ?? []).filter((n) => n.id !== note.id));
  };

  return (
    <section
      aria-labelledby={`${fieldId}-title`}
      className="nd-rise flex flex-col gap-3 rounded-[20px] border border-line bg-surface p-4"
      style={{ "--d": 1 } as CSSProperties}
    >
      <h3
        id={`${fieldId}-title`}
        className="m-0 font-display text-base font-semibold text-foreground"
      >
        {t.title}
      </h3>

      {summary ? (
        <div className="flex flex-col gap-1 rounded-[14px] bg-aiden-soft px-3 py-2.5 text-[0.9375rem]">
          <p className="m-0 flex items-center gap-1.5 text-sm font-semibold text-aiden-deep">
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            {t.summary(when(summary.created_at))}
          </p>
          <p className="m-0 whitespace-pre-wrap text-foreground">{summary.output.trim()}</p>
          <p className="m-0 text-[0.8125rem] text-muted-foreground">{t.summaryFrom}</p>
        </div>
      ) : null}

      {notes === null ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label={t.loading}>
          <Skeleton className="h-16 w-full rounded-[12px]" />
          <Skeleton className="h-4 w-2/3 rounded-full" />
        </div>
      ) : state === "unavailable" ? (
        <p className="m-0 text-[0.9375rem] text-muted-foreground">{t.unavailable}</p>
      ) : state === "error" ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1" role="alert">
          <p className="m-0 text-[0.9375rem] text-muted-foreground">{t.loadFailed}</p>
          <Button
            variant="outline"
            size="sm"
            className="phone:h-11"
            onClick={() => {
              setNotes(null);
              void load();
            }}
          >
            {t.retry}
          </Button>
        </div>
      ) : (
        <>
          {canWrite ? (
            <div className="flex flex-col gap-2">
              <label htmlFor={fieldId} className="sr-only">
                {t.fieldLabel}
              </label>
              <Textarea
                id={fieldId}
                value={draft}
                maxLength={NOTE_MAX}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={t.placeholder}
                rows={2}
                className="min-h-[64px] resize-y rounded-[12px] border-line text-[0.9375rem] shadow-none md:text-[0.9375rem]"
              />
              <Button
                size="sm"
                className="w-fit self-end phone:h-11"
                disabled={busy || !draft.trim() || !me}
                onClick={() => void add()}
              >
                {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : null}
                {t.add}
              </Button>
            </div>
          ) : null}
          {notes.length === 0 ? (
            <p className="m-0 text-[0.9375rem] text-muted-foreground">{t.empty}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {notes.map((n) => (
                <li
                  key={n.id}
                  className="flex flex-col gap-1 border-t border-line pt-3 animate-in fade-in slide-in-from-top-2 duration-300 ease-out first:border-t-0 first:pt-0 motion-reduce:animate-none"
                >
                  <p className="m-0 whitespace-pre-wrap text-[0.9375rem]">{n.body}</p>
                  <p className="m-0 flex items-center justify-between gap-2 text-[0.8125rem] text-muted-foreground">
                    <span>
                      {n.author_id ? (names[n.author_id] ?? t.teammate) : t.teammate},{" "}
                      {when(n.created_at)}
                    </span>
                    {me && n.author_id === me ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={busy}
                        onClick={() => void remove(n)}
                        aria-label={t.deleteLabel}
                        className="text-muted-foreground hover:text-danger-soft-foreground phone:h-11 phone:w-11"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    ) : null}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
