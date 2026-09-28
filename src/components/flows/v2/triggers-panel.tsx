import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { callApi } from "@/lib/whatsapp-client";

export type TriggerRow = {
  id: string;
  kind: string;
  config: Record<string, unknown>;
  is_enabled: boolean;
};

const KIND_LABELS: Record<string, string> = {
  keyword: "Keyword",
  first_message: "First message ever",
  ctwa_ad: "Click-to-WhatsApp ad",
  store_event: "Store event",
  form_submitted: "Form submitted",
  tag_added: "Tag added",
  campaign_button: "Campaign button tapped",
  no_reply: "No reply for N days",
  manual: "Manual from inbox",
};

const STORE_EVENTS = [
  ["abandoned_checkout", "Abandoned checkout"],
  ["order_created", "Order created"],
  ["order_fulfilled", "Order shipped"],
  ["order_delivered", "Order delivered"],
] as const;

export function TriggersPanel({
  organizationId,
  flowId,
  canEdit,
  forms,
  tags,
}: {
  organizationId: string;
  flowId: string;
  canEdit: boolean;
  forms: Array<{ id: string; name: string }>;
  tags: string[];
}) {
  const [rows, setRows] = useState<TriggerRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<string>("keyword");
  const [keywords, setKeywords] = useState("");
  const [match, setMatch] = useState("contains");
  const [event, setEvent] = useState("abandoned_checkout");
  const [formId, setFormId] = useState("");
  const [tag, setTag] = useState("");
  const [days, setDays] = useState("3");

  const load = useCallback(async () => {
    const { data, error } = await callApi<{ triggers: TriggerRow[] }>("/api/flows/triggers", {
      body: { action: "list", organization_id: organizationId, flow_id: flowId },
    });
    if (error) toast.error(error);
    setRows(data?.triggers ?? []);
  }, [organizationId, flowId]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    const config: Record<string, unknown> =
      kind === "keyword"
        ? { keywords: keywords.split(",").map((k) => k.trim()).filter(Boolean), match }
        : kind === "store_event"
          ? { event }
          : kind === "form_submitted"
            ? { form_id: formId || null }
            : kind === "tag_added"
              ? { tag }
              : kind === "no_reply"
                ? { days: Number(days) || 3 }
                : {};
    setBusy(true);
    const { error } = await callApi("/api/flows/triggers", {
      body: { action: "add", organization_id: organizationId, flow_id: flowId, trigger: { kind, config, is_enabled: true } },
    });
    setBusy(false);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success("Trigger added.");
    setKeywords("");
    setTag("");
    void load();
  };

  const toggle = async (row: TriggerRow) => {
    await callApi("/api/flows/triggers", {
      body: { action: "update", organization_id: organizationId, trigger_id: row.id, trigger: { is_enabled: !row.is_enabled } },
    });
    void load();
  };

  const remove = async (row: TriggerRow) => {
    await callApi("/api/flows/triggers", {
      body: { action: "remove", organization_id: organizationId, trigger_id: row.id },
    });
    void load();
  };

  const describe = (row: TriggerRow): string => {
    const c = row.config;
    switch (row.kind) {
      case "keyword":
        return `${((c["keywords"] as string[]) ?? []).join(", ")} (${String(c["match"] ?? "contains").replace("_", " ")})`;
      case "store_event":
        return STORE_EVENTS.find(([v]) => v === c["event"])?.[1] ?? String(c["event"] ?? "");
      case "form_submitted":
        return c["form_id"] ? `Form: ${forms.find((f) => f.id === c["form_id"])?.name ?? "selected form"}` : "Any form";
      case "tag_added":
        return `Tag: ${String(c["tag"] ?? "")}`;
      case "campaign_button":
        return c["button"] ? `Button “${String(c["button"])}”` : "Any campaign button";
      case "no_reply":
        return `After ${String(c["days"] ?? 3)} quiet days`;
      default:
        return "";
    }
  };

  return (
    <div className="mt-4 space-y-4">
      <p className="text-sm text-muted-foreground">
        What starts this flow. A message first goes to a flow that's already waiting for this customer's reply — triggers
        only fire when no flow is waiting.
      </p>

      {rows === null ? (
        <div className="space-y-2">
          <div className="h-12 animate-pulse rounded-xl bg-muted" />
          <div className="h-12 animate-pulse rounded-xl bg-muted" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
          No triggers yet — the flow only starts when you add one.
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-2 rounded-xl border border-border p-3 text-sm">
              <Zap className={`h-4 w-4 shrink-0 ${r.is_enabled ? "text-primary" : "text-muted-foreground"}`} />
              <div className="min-w-0 flex-1">
                <p className="font-medium">{KIND_LABELS[r.kind] ?? r.kind}</p>
                <p className="truncate text-xs text-muted-foreground">{describe(r)}</p>
              </div>
              {canEdit && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => void toggle(r)}>
                    {r.is_enabled ? "Pause" : "Enable"}
                  </Button>
                  <Button size="icon" variant="ghost" aria-label="Remove trigger" onClick={() => void remove(r)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="space-y-3 rounded-xl border border-border p-3">
          <div className="space-y-1.5">
            <Label>Trigger type</Label>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(KIND_LABELS).map(([v, l]) => (
                  <SelectItem key={v} value={v}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {kind === "keyword" && (
            <>
              <div className="space-y-1.5">
                <Label>Keywords (comma separated, any language)</Label>
                <Input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="menu, price, कीमत" />
              </div>
              <div className="space-y-1.5">
                <Label>Match</Label>
                <Select value={match} onValueChange={setMatch}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="contains">Contains</SelectItem>
                    <SelectItem value="exact">Exactly this</SelectItem>
                    <SelectItem value="starts_with">Starts with</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
          {kind === "store_event" && (
            <div className="space-y-1.5">
              <Label>Event</Label>
              <Select value={event} onValueChange={setEvent}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STORE_EVENTS.map(([v, l]) => (
                    <SelectItem key={v} value={v}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {kind === "form_submitted" && (
            <div className="space-y-1.5">
              <Label>Form (leave empty for any form)</Label>
              <Select value={formId || "__any"} onValueChange={(v) => setFormId(v === "__any" ? "" : v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__any">Any form</SelectItem>
                  {forms.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {kind === "tag_added" && (
            <div className="space-y-1.5">
              <Label>Tag</Label>
              <Input list="flow-trigger-tags" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="VIP" />
              <datalist id="flow-trigger-tags">
                {tags.map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </div>
          )}
          {kind === "no_reply" && (
            <div className="space-y-1.5">
              <Label>Days without a customer reply (1–90)</Label>
              <Input type="number" min={1} max={90} value={days} onChange={(e) => setDays(e.target.value)} />
            </div>
          )}
          {kind === "campaign_button" && (
            <p className="text-xs text-muted-foreground">Starts when a customer taps a button on a campaign message.</p>
          )}
          {kind === "manual" && (
            <p className="text-xs text-muted-foreground">Lets your team start this flow from the inbox.</p>
          )}

          <Button size="sm" disabled={busy} onClick={() => void add()}>
            <Plus className="mr-1 h-4 w-4" /> Add trigger
          </Button>
        </div>
      )}
    </div>
  );
}
