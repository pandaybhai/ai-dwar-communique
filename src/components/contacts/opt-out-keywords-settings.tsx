import { useCallback, useEffect, useState } from "react";
import { Ban, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { logActivity } from "@/lib/activity";
import { DEFAULT_OPT_IN_KEYWORDS, DEFAULT_OPT_OUT_KEYWORDS } from "@/lib/opt-out";
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

type KeywordRow = { id: string; keyword: string; action: "opt_out" | "opt_in" };

export function OptOutKeywordsCard() {
  const { active, canManage } = useOrg();
  const organizationId = active?.organization.id ?? null;

  const [rows, setRows] = useState<KeywordRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [action, setAction] = useState<"opt_out" | "opt_in">("opt_out");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!organizationId) return;
    const { data, error: err } = await aidwar
      .from("opt_out_keywords")
      .select("id, keyword, action")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: true });
    if (err) {
      setError(err.message);
      setRows([]);
      return;
    }
    setError(null);
    setRows((data as KeywordRow[]) ?? []);
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    if (!organizationId) return;
    const value = keyword.trim();
    if (!value) {
      toast.error("Add the word people will send you.");
      return;
    }
    setSaving(true);
    const { error: err } = await aidwar
      .from("opt_out_keywords")
      .insert({ organization_id: organizationId, keyword: value, action });
    setSaving(false);
    if (err) {
      toast.error(
        err.code === "23505" ? "That keyword already exists." : "Couldn't save this keyword.",
      );
      return;
    }
    await logActivity("opt_out_keyword_created", organizationId, { action });
    setKeyword("");
    toast.success("Keyword added.");
    void load();
  }

  async function remove(row: KeywordRow) {
    if (!organizationId) return;
    const { error: err } = await aidwar.from("opt_out_keywords").delete().eq("id", row.id);
    if (err) {
      toast.error("Couldn't remove this keyword.");
      return;
    }
    await logActivity("opt_out_keyword_deleted", organizationId, { action: row.action });
    void load();
  }

  const chip = (text: string, kind: "opt_out" | "opt_in") => (
    <span
      key={`${kind}-${text}`}
      className={`inline-flex rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${
        kind === "opt_out"
          ? "border-destructive/25 bg-destructive/10 text-destructive"
          : "border-primary/25 bg-primary/10 text-primary"
      }`}
    >
      {text}
    </span>
  );

  return (
    <div className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
          <Ban className="h-5 w-5" />
        </div>
        <div>
          <h2 className="font-heading text-lg font-semibold text-foreground">Opt-out keywords</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            When a customer sends one of these words, we stop marketing to them straight away and
            send a short confirmation. These words always work, and you can add your own.
          </p>
        </div>
      </div>

      <div className="mt-5 space-y-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Always unsubscribes
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {DEFAULT_OPT_OUT_KEYWORDS.map((k) => chip(k, "opt_out"))}
          </div>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Always resubscribes
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {DEFAULT_OPT_IN_KEYWORDS.map((k) => chip(k, "opt_in"))}
          </div>
        </div>
      </div>

      {canManage ? (
        <div className="mt-6 grid gap-3 sm:grid-cols-[1fr_180px_auto]">
          <div className="space-y-1.5">
            <Label htmlFor="opt-keyword">Your own keyword</Label>
            <Input
              id="opt-keyword"
              placeholder="e.g. no more"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Does what</Label>
            <Select value={action} onValueChange={(v) => setAction(v as "opt_out" | "opt_in")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="opt_out">Unsubscribes</SelectItem>
                <SelectItem value="opt_in">Resubscribes</SelectItem>
              </SelectContent>
            </Select>
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
            <p className="text-sm font-medium text-foreground">No custom keywords yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              The defaults above already protect your customers.
            </p>
          </div>
        ) : (
          rows.map((r) => (
            <div
              key={r.id}
              className="flex items-center gap-3 rounded-xl border border-border/60 bg-background/60 p-3 transition-colors duration-200 hover:border-primary/30"
            >
              <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                “{r.keyword}”
              </p>
              {chip(r.action === "opt_out" ? "Unsubscribes" : "Resubscribes", r.action)}
              {canManage ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => void remove(r)}
                  aria-label="Remove keyword"
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
