import { useCallback, useEffect, useState } from "react";
import { aidwar } from "@/integrations/aidwar/client";
import { useOrg } from "@/lib/org-context";
import { NUMBER_COLUMNS, sortNumbers, type WhatsAppNumber } from "@/lib/whatsapp-numbers";

type Options = {
  /** Only numbers that can currently send. Defaults to true. */
  activeOnly?: boolean;
};

/**
 * The connected numbers for the current workspace. Everything that scopes by
 * number — inbox filter, campaign sender, template library — reads this, so a
 * future permission that limits a teammate to specific numbers only has to
 * narrow this one query.
 */
export function useWhatsAppNumbers(options: Options = {}) {
  const activeOnly = options.activeOnly ?? true;
  const { active } = useOrg();
  const orgId = active?.organization.id;

  const [numbers, setNumbers] = useState<WhatsAppNumber[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!orgId) {
      setNumbers([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    let query = aidwar
      .from("whatsapp_accounts")
      .select(NUMBER_COLUMNS)
      .eq("organization_id", orgId);
    if (activeOnly) query = query.eq("status", "active");

    const { data, error: err } = await query;
    setLoading(false);
    if (err) {
      setError("We couldn't load your connected numbers. Please refresh.");
      return;
    }
    setNumbers(sortNumbers((data ?? []) as WhatsAppNumber[]));
  }, [orgId, activeOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  const defaultNumber = numbers.find((n) => n.is_default) ?? numbers[0] ?? null;

  return {
    numbers,
    defaultNumber,
    /** True once a workspace runs more than one number — drives the extra UI. */
    multiple: numbers.length > 1,
    loading,
    error,
    reload: load,
  };
}
