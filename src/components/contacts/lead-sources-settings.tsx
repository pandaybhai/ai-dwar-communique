import { useCallback, useEffect, useState } from "react";
import { Plus, Radar, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { logActivity } from "@/lib/activity";
import { SOURCE_LABELS, sourceClass, sourceLabel } from "@/lib/contacts";
import { useOrg } from "@/lib/org-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type MarkerRow = {
  id: string;
  marker: string;
  source: string;
  label: string | null;
};

const SOURCE_CHOICES = Object.keys(SOURCE_LABELS).filter(
  (s) => !["import", "manual", "ctwa_facebook", "ctwa_instagram"].includes(s),
);

export function LeadSourcesTab() {
  const { active, canManage } = useOrg();
  const organizationId = active?.organization.id ?? null;
  const canEdit = canManage;

  const [rows, setRows] = useState<MarkerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [marker, setMarker] = useState("");
  const [source, setSource] = useState("website");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!organizationId) return;
    const { data, error: err } = await aidwar
      .from("lead_source_markers")
      .select("id, marker, source, label")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: true });
    if (err) {
      setError(err.message);
      setRows([]);
      return;
    }
    setError(null);
    setRows((data as MarkerRow[]) ?? []);
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    if (!organizationId) return;
    const value = marker.trim();
    if (!value) {
      toast.error("Add the text people will send you.");
      return;
    }
    setSaving(true);
    const { error: err } = await aidwar.from("lead_source_markers").insert({
      organization_id: organizationId,
      marker: value,
      source,
      label: label.trim() || null,
    });
    setSaving(false);
    if (err) {
      toast.error(
        err.code === "23505" ? "That marker already exists." : "Couldn't save this marker.",
      );
      return;
    }
    await logActivity(organizationId, "lead_source_marker.created", { marker: value, source });
    setMarker("");
    setLabel("");
    toast.success("Tracking marker added.");
    void load();
  }

  async function remove(row: MarkerRow) {
    if (!organizationId) return;
    const { error: err } = await aidwar.from("lead_source_markers").delete().eq("id", row.id);
    if (err) {
      toast.error("Couldn't remove this marker.");
      return;
    }
    await logActivity(organizationId, "lead_source_marker.deleted", { marker: row.marker });
    void load();
  }

  return (
    <div className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Radar className="h-5 w-5" />
        </div>
        <div>
          <h2 className="font-heading text-lg font-semibold text-foreground">Lead sources</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            When someone messages you for the first time, we look for these words in their message
            and record where the lead came from. Ad clicks are detected automatically.
          </p>
        </div>
      </div>

      {canEdit ? (
        <div className="mt-6 grid gap-3 sm:grid-cols-[1fr_180px_1fr_auto]">
          <div className="space-y-1.5">
            <Label htmlFor="marker">First message contains</Label>
            <Input
              id="marker"
              placeholder="e.g. Hi from website"
              value={marker}
              onChange={(e) => setMarker(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Source</Label>
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SOURCE_CHOICES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {sourceLabel(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="marker-label">Note (optional)</Label>
            <Input
              id="marker-label"
              placeholder="Homepage chat button"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <div className="flex items-end">
            <Button className="rounded-full" onClick={() => void add()} disabled={saving}>
              <Plus className="mr-2 h-4 w-4" />
              {saving ? "Adding…" : "Add"}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="mt-6 space-y-2">
        {rows === null ? (
          <>
            <Skeleton className="h-12 w-full rounded-xl" />
            <Skeleton className="h-12 w-full rounded-xl" />
          </>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : rows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-muted/30 p-6 text-center">
            <p className="text-sm font-medium text-foreground">No tracking markers yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Add one to tell website chats apart from social traffic.
            </p>
          </div>
        ) : (
          rows.map((r) => (
            <div
              key={r.id}
              className="flex items-center gap-3 rounded-xl border border-border/60 bg-background/60 p-3 transition-colors duration-200 hover:border-primary/30"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">“{r.marker}”</p>
                {r.label ? (
                  <p className="truncate text-xs text-muted-foreground">{r.label}</p>
                ) : null}
              </div>
              <span
                className={`inline-flex whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${sourceClass(r.source)}`}
              >
                {sourceLabel(r.source)}
              </span>
              {canEdit ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => void remove(r)}
                  aria-label="Remove marker"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
