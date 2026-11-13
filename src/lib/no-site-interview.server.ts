import type { SupabaseClient } from "@supabase/supabase-js";
import { getScript } from "@/lib/scripts.server";
import {
  INTERVIEW,
  MEDIA_STEP,
  SKIP_MEDIA_ID,
  nextInterviewStep,
  questionFor,
  type InterviewStep,
} from "@/lib/no-site-interview";

/**
 * Batch 78: the no-website interview's turns on AiDwar's own number (the
 * merchant channel calls these; the order, the scripts and the steps are in
 * no-site-interview.ts). Each answer is saved with the existing fact-saver
 * (saveFact → the workspace's manual_qa source) as "<topic>: <answer>", so a
 * short "no" to the returns question still means something. A photo or PDF
 * goes through the pipeline's own media stage (ingestUpload), which then
 * gives the same brief and "test me" as a website; Skip on the price list
 * ends the interview at the same "ready" step.
 */

type Session = { id: string; organization_id: string; user_id: string; step: string | null };

export type InterviewIo = {
  reply: (text: string) => Promise<unknown>;
  replyButtons: (text: string, buttons: Array<{ id: string; title: string }>) => Promise<unknown>;
  patchSession: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
};

async function ask(supabase: SupabaseClient, step: InterviewStep, io: InterviewIo): Promise<void> {
  if (step === MEDIA_STEP) {
    await io.replyButtons(await getScript(supabase, "interview_media"), [
      { id: SKIP_MEDIA_ID, title: "Skip" },
    ]);
    return;
  }
  const q = questionFor(step);
  if (q) await io.reply(await getScript(supabase, q.script));
}

/** Right after the Day-one intro: the first question. */
export async function startInterview(
  supabase: SupabaseClient,
  session: Session,
  io: InterviewIo,
): Promise<void> {
  const first = INTERVIEW[0].step;
  await io.patchSession(session.id, { status: "bound", step: first });
  session.step = first;
  await ask(supabase, first, io);
}

/** Asks the current question again (a greeting, "help", the intro's button). */
export async function askAgain(
  supabase: SupabaseClient,
  step: InterviewStep,
  io: InterviewIo,
): Promise<void> {
  await ask(supabase, step, io);
}

/**
 * One owner message during the interview. Returns true when it was taken
 * (always, for a typed message or a tap on this step's buttons).
 */
export async function interviewTurn(
  supabase: SupabaseClient,
  args: {
    session: Session;
    step: InterviewStep;
    body: string;
    interactiveId: string | null;
    businessName: string;
    control: "skip" | "help" | "test" | "greeting" | "ack" | null;
  },
  io: InterviewIo,
): Promise<boolean> {
  const { session, step } = args;
  const body = args.body.trim();

  if (args.interactiveId === "start" || ["greeting", "help", "test"].includes(args.control ?? "")) {
    await ask(supabase, step, io);
    return true;
  }
  const skipped = args.interactiveId === SKIP_MEDIA_ID || args.control === "skip";

  if (step === MEDIA_STEP) {
    if (skipped) {
      await finishInterview(supabase, session, args.businessName, io);
      return true;
    }
    if (!body) return false;
    // Words instead of a file: kept, and the price list asked for again.
    await save(supabase, session, "About the business", body);
    await ask(supabase, step, io);
    return true;
  }

  if (!skipped) {
    if (!body) return false;
    const q = questionFor(step);
    if (q) await save(supabase, session, q.topic, body);
  }
  const next = nextInterviewStep(step);
  if (!next) return true;
  await io.patchSession(session.id, { step: next });
  session.step = next;
  await ask(supabase, next, io);
  return true;
}

/** Skip on the price list: the same "ready to test" step a website reaches. */
export async function finishInterview(
  supabase: SupabaseClient,
  session: Session,
  businessName: string,
  io: InterviewIo,
): Promise<void> {
  await io.patchSession(session.id, { status: "ready", step: "answering" });
  session.step = "answering";
  await io.reply(
    await getScript(supabase, "interview_done", { business: businessName || "your business" }),
  );
}

async function save(
  supabase: SupabaseClient,
  session: Session,
  topic: string,
  answer: string,
): Promise<void> {
  const { saveFact } = await import("@/lib/knowledge.server");
  const saved = await saveFact(supabase, session.organization_id, {
    topic,
    text: `${topic}: ${answer.slice(0, 1500)}`,
    userId: session.user_id,
  });
  if (!saved.ok) {
    console.log(
      JSON.stringify({
        scope: "no_site_interview",
        stage: "save_failed",
        topic,
        error: saved.error,
      }),
    );
  }
}
