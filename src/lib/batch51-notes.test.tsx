import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fakeDb, type FakeOp } from "./test-support/fake-db";
import {
  addNote,
  canWriteNotes,
  deleteNote,
  noteInsert,
  NOTE_MAX,
} from "@/components/customers-v2/customer-notes";

/**
 * Batch 51, gap 4 — notes on a customer in the new design's drawer. Who may
 * write (contacts.edit or inbox.reply; RLS in batch51-sql.test.ts enforces
 * it, and that a note is written as yourself and deleted only by you), every
 * add and delete is in the activity log without the words, and Aiden neither
 * reads notes nor is asked for a summary: only a "Catch me up" summary that
 * already exists is shown.
 */

const ORG = "org-51";
const NOTE = {
  id: "n1",
  body: "Prefers a call after 6 pm",
  author_id: "u1",
  created_at: "2026-10-29T08:00:00Z",
};

describe("who may write a note", () => {
  it("someone who edits contacts or replies to customers; a read-only viewer can't", () => {
    const can = (keys: string[]) => (k: string) => keys.includes(k);
    expect(canWriteNotes(can(["contacts.view", "contacts.edit"]))).toBe(true);
    expect(canWriteNotes(can(["contacts.view", "inbox.reply"]))).toBe(true);
    expect(canWriteNotes(can(["contacts.view"]))).toBe(false);
  });

  it("a note is the workspace, the customer, the writer and the words (trimmed, at most 2,000)", () => {
    expect(
      noteInsert({ organizationId: ORG, contactId: "c1", userId: "u1", body: "  Gift wrap  " }),
    ).toEqual({
      organization_id: ORG,
      contact_id: "c1",
      author_id: "u1",
      body: "Gift wrap",
    });
    expect(
      noteInsert({ organizationId: ORG, contactId: "c1", userId: "u1", body: "x".repeat(3000) })
        .body,
    ).toHaveLength(NOTE_MAX);
  });
});

describe("audit: every add and delete is logged, never the words", () => {
  it("adding saves through the member's client and logs contact_note_added", async () => {
    const log = vi.fn(async () => {});
    const db = fakeDb((op: FakeOp) =>
      op.table === "contact_notes" && op.kind === "insert"
        ? { data: NOTE, error: null }
        : undefined,
    );
    const res = await addNote(db.supabase, log, {
      organizationId: ORG,
      contactId: "c1",
      userId: "u1",
      body: NOTE.body,
    });
    expect(res).toEqual({ note: NOTE });
    expect(db.ops[0]!.payload).toEqual({
      organization_id: ORG,
      contact_id: "c1",
      author_id: "u1",
      body: NOTE.body,
    });
    expect(log).toHaveBeenCalledWith("contact_note_added", ORG, {
      contact_id: "c1",
      note_id: "n1",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("6 pm");
  });

  it("an empty note, or a refused write, isn't saved or logged", async () => {
    const log = vi.fn(async () => {});
    const refused = fakeDb(() => ({
      data: null,
      error: { code: "42501", message: "row-level security" },
    }));
    expect(
      await addNote(refused.supabase, log, {
        organizationId: ORG,
        contactId: "c1",
        userId: "u1",
        body: "  ",
      }),
    ).toEqual({
      error: "Write the note first.",
    });
    expect(refused.ops).toEqual([]);
    expect(
      await addNote(refused.supabase, log, {
        organizationId: ORG,
        contactId: "c1",
        userId: "u1",
        body: "x",
      }),
    ).toEqual({
      // Batch 57: copy
      error: "Couldn't save that note. Check your internet and tap Add note again.",
    });
    const missing = fakeDb(() => ({
      data: null,
      error: { code: "PGRST205", message: "no table" },
    }));
    expect(
      await addNote(missing.supabase, log, {
        organizationId: ORG,
        contactId: "c1",
        userId: "u1",
        body: "x",
      }),
    ).toEqual({
      error: "Notes aren't switched on for this workspace yet.",
    });
    expect(log).not.toHaveBeenCalled();
  });

  it("deleting asks for the writer's own note and logs contact_note_deleted", async () => {
    const log = vi.fn(async () => {});
    const db = fakeDb(() => undefined);
    expect(
      await deleteNote(db.supabase, log, {
        organizationId: ORG,
        contactId: "c1",
        userId: "u1",
        noteId: "n1",
      }),
    ).toEqual({
      ok: true,
    });
    const op = db.ops[0]!;
    expect(op.kind).toBe("delete");
    expect(db.has(op, "eq", "author_id", "u1")).toBe(true);
    expect(db.has(op, "eq", "organization_id", ORG)).toBe(true);
    expect(log).toHaveBeenCalledWith("contact_note_deleted", ORG, {
      contact_id: "c1",
      note_id: "n1",
    });
  });

  it("the two activity names are registered with the contacts feature", async () => {
    const { FEATURES } = await import("./feature-registry");
    const contacts = FEATURES.find((f) => f.key === "contacts")!;
    expect(contacts.activity_actions).toEqual(
      expect.arrayContaining(["contact_note_added", "contact_note_deleted"]),
    );
    expect(contacts.data_tables).toEqual(
      expect.arrayContaining(["contact_notes", "segment_members"]),
    );
  });
});

describe("Aiden: no new AI call, and notes don't reach him", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : [p];
    });

  it("the drawer only reads an existing Catch me up summary; it never asks for one", () => {
    const code = readFileSync("src/components/customers-v2/customer-notes.tsx", "utf8");
    expect(code).toContain('.eq("task", "summarise")');
    expect(code).toContain('.not("user_id", "is", null)');
    for (const banned of ["aiRunApi", "/api/internal/ai-run", "employeeApi", "callApi"])
      expect(code).not.toContain(banned);
  });

  it("no server code reads contact_notes (Aiden's context builder is unchanged)", () => {
    const readers = files("src")
      .filter((p) => /\.(ts|tsx)$/.test(p) && !/\.test\.|test-support/.test(p))
      .filter((p) => readFileSync(p, "utf8").includes("contact_notes"));
    expect(readers.sort()).toEqual([
      "src/components/customers-v2/customer-notes.tsx",
      "src/lib/feature-registry.ts",
    ]);
  });

  it("the drawer shows the block only in the new design; the classic drawer is unchanged", () => {
    const view = readFileSync("src/components/customers-v2/new-contacts-view.tsx", "utf8");
    expect(view).toContain("<CustomerNotes");
    expect(view).toContain("canWrite={canWriteNotes(can)}");
    const classic = readFileSync("src/components/contacts/contact-drawer.tsx", "utf8");
    expect(classic).not.toContain("CustomerNotes");
  });
});
