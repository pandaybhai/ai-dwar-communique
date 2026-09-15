/** Browser-safe shape of a recorded AI proof run shown on the demo page. */
export type PublicProof = {
  scenario: string;
  question: string;
  answer: string;
  status: string;
  escalation_signal: string | null;
  workflow_state: string;
  model_display: string | null;
  captured_at: string;
  source_facts: Array<{ title: string; content: string }>;
};
