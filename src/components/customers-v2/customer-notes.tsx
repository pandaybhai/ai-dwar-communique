import { useCallback, useEffect, useId, useState } from "react";
import { Loader2, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { SupabaseClient } from "@supabase/supabase-js";
import { aidwar } from "@/integrations/aidwar/client";
import { logActivity } from "@/lib/activity";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

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
  if (!args.body.trim()) return { error: "Write the note first." };
  const { data, error } = await db
    .from("contact_notes")
    .insert(noteInsert(args))
    .select("id, body, author_id, created_at")
    .single();
  if (error || !data)
    return {
      error: missingTable(error?.code)
        ? "Notes aren't switched on for this workspace yet."
        : "We couldn't save that note. Please try again.",
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
  if (error) return { error: "We couldn't delete that note." };
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
        map[p.id] = p.full_name?.trim() || p.email || "Teammate";
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
      className="flex flex-col gap-3 rounded-[20px] border border-line bg-surface p-4"
    >
      <h3
        id={`${fieldId}-title`}
        className="m-0 font-display text-base font-semibold text-foreground"
      >
        Notes
      </h3>

      {summary ? (
        <div className="flex flex-col gap-1 rounded-[14px] bg-aiden-soft px-3 py-2.5 text-[0.9375rem]">
          <p className="m-0 flex items-center gap-1.5 text-sm font-semibold text-aiden-deep">
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            Aiden’s last summary, {when(summary.created_at)}
          </p>
          <p className="m-0 whitespace-pre-wrap text-foreground">{summary.output.trim()}</p>
          <p className="m-0 text-[0.8125rem] text-muted-foreground">
            From “Catch me up” in the Inbox.
          </p>
        </div>
      ) : null}

      {notes === null ? (
        <Loader2
          className="h-4 w-4 animate-spin text-muted-foreground motion-reduce:animate-none"
          aria-label="Loading notes"
        />
      ) : state === "unavailable" ? (
        <p className="m-0 text-[0.9375rem] text-muted-foreground">
          Notes aren’t switched on for this workspace yet.
        </p>
      ) : state === "error" ? (
        <p className="m-0 text-[0.9375rem] text-muted-foreground">
          We couldn’t load notes. Please try again.
        </p>
      ) : (
        <>
          {canWrite ? (
            <div className="flex flex-col gap-2">
              <label htmlFor={fieldId} className="sr-only">
                Add a note about this customer
              </label>
              <Textarea
                id={fieldId}
                value={draft}
                maxLength={NOTE_MAX}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Add a note for your team"
                rows={2}
                className="min-h-[64px] resize-y rounded-[12px] border-line text-[0.9375rem] shadow-none md:text-[0.9375rem]"
              />
              <Button
                size="sm"
                className="w-fit self-end"
                disabled={busy || !draft.trim() || !me}
                onClick={() => void add()}
              >
                {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : null}
                Add note
              </Button>
            </div>
          ) : null}
          {notes.length === 0 ? (
            <p className="m-0 text-[0.9375rem] text-muted-foreground">
              No notes yet. Only your team sees them.
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {notes.map((n) => (
                <li
                  key={n.id}
                  className="flex flex-col gap-1 border-t border-line pt-3 first:border-t-0 first:pt-0"
                >
                  <p className="m-0 whitespace-pre-wrap text-[0.9375rem]">{n.body}</p>
                  <p className="m-0 flex items-center justify-between gap-2 text-[0.8125rem] text-muted-foreground">
                    <span>
                      {n.author_id ? (names[n.author_id] ?? "Teammate") : "Teammate"},{" "}
                      {when(n.created_at)}
                    </span>
                    {me && n.author_id === me ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={busy}
                        onClick={() => void remove(n)}
                        aria-label="Delete this note"
                        className="text-muted-foreground hover:text-danger-soft-foreground"
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
