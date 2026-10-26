/**
 * Batch 28 item 11: what counts as an "AI answer" for the plan allowance, the
 * Billing page's "AI answers used" and the over-allowance debit.
 *
 * An answer is a reply Aiden wrote to a customer in a real conversation:
 *   ai_runs.status = 'ok' and task = 'agent_reply' and conversation_id set,
 *   with no metadata.purpose (background work such as reading a customer's
 *   photo, 'customer_image', or a knowledge picture is tagged with one) and not
 *   the owner's own onboarding chat (metadata.channel 'onboarding').
 *
 * Never an answer: website reading (extract_facts), the inbox's "Draft a
 * reply" and Draft-mode drafts (suggest_reply), "Catch me up" and the policy
 * check (summarise), labels (auto_tag), and Try me / comparisons / the day-one
 * brief (agent_reply with no conversation).
 *
 * The database says the same in public.ai_run_is_customer_answer
 * (supabase/aidwar-migrations/20261084_batch28_ai_answers_only_replies.sql),
 * used by trg_ai_runs_billing and billing_debit_ai_run. Keep the two in step.
 */

/** ai_runs.task of Aiden's reply to a customer (executeRun via agentAnswer). */
export const CUSTOMER_ANSWER_TASK = "agent_reply" as const;

/** metadata.channel of the owner's onboarding chat (merchantAnswer). */
export const ONBOARDING_CHANNEL = "onboarding" as const;

export type AnswerRunFields = {
  status?: string | null;
  task?: string | null;
  conversation_id?: string | null;
  metadata?: Record<string, unknown> | null;
};

/** The same rule for a row already read (status 'ok' included). */
export function isCustomerAnswer(run: AnswerRunFields): boolean {
  const meta = run.metadata ?? null;
  return (
    run.status === "ok" &&
    run.task === CUSTOMER_ANSWER_TASK &&
    Boolean(run.conversation_id) &&
    (meta?.["purpose"] ?? null) === null &&
    (meta?.["channel"] ?? null) !== ONBOARDING_CHANNEL
  );
}

/** The PostgREST filters this needs from a query builder. */
type AnswerFilterable = {
  eq(column: string, value: string): AnswerFilterable;
  not(column: string, operator: string, value: null): AnswerFilterable;
  is(column: string, value: null): AnswerFilterable;
  or(filters: string): AnswerFilterable;
};

/**
 * Narrows an ai_runs read to customer answers (status 'ok' included), so a
 * count is the count the billing trigger uses. Returns the same builder.
 */
export function onlyCustomerAnswers<Q>(query: Q): Q {
  return (query as unknown as AnswerFilterable)
    .eq("status", "ok")
    .eq("task", CUSTOMER_ANSWER_TASK)
    .not("conversation_id", "is", null)
    .is("metadata->>purpose", null)
    .or(`metadata->>channel.is.null,metadata->>channel.neq.${ONBOARDING_CHANNEL}`) as unknown as Q;
}
