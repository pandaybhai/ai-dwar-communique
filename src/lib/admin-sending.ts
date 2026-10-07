/** Shapes of the super-admin "Sending now" view (Batch 12). */
export type SendingRow = {
  id: string;
  name: string;
  workspace: string;
  status: string;
  number_id: string | null;
  total: number;
  sent: number;
  failed: number;
  delivered: number;
  remaining: number | null;
  rate_per_sec: number | null;
  eta_seconds: number | null;
  started_at: string | null;
  completed_at: string | null;
};

export type SendingNow = {
  generated_at: string;
  window_seconds: number;
  total_rate_per_sec: number;
  active: SendingRow[];
  recent: SendingRow[];
};
