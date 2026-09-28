import { useEffect, useState } from "react";
import { aidwar } from "@/integrations/aidwar/client";
import { useOrg } from "@/lib/org-context";
import { useFeatureFlag } from "@/hooks/use-feature-flag";

export type PublishedForm = { id: string; name: string; meta_flow_id: string | null };

/** Published WhatsApp forms, only when the forms feature is on. */
export function usePublishedForms(): PublishedForm[] {
  const { active } = useOrg();
  const { enabled } = useFeatureFlag("wa_forms");
  const [forms, setForms] = useState<PublishedForm[]>([]);
  const orgId = active?.organization.id ?? null;
  useEffect(() => {
    if (!enabled || !orgId) return;
    void aidwar
      .from("wa_forms")
      .select("id, name, meta_flow_id")
      .eq("organization_id", orgId)
      .eq("status", "published")
      .then(({ data }) => setForms((data ?? []) as PublishedForm[]));
  }, [enabled, orgId]);
  return enabled ? forms : [];
}
