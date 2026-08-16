import { useCallback, useEffect, useState } from "react";
import { Ban, Lock, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { logActivity } from "@/lib/activity";
import {
  DEFAULT_OPT_IN_KEYWORDS,
  DEFAULT_OPT_OUT_KEYWORDS,
  normalizeKeyword,
} from "@/lib/opt-out";
import { useOrg } from "@/lib/org-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

type KeywordAction = "opt_out" | "opt_in";
type KeywordRow = { id: string; keyword: string; action: KeywordAction };

const BUILT_INS: Record<KeywordAction, string[]> = {
  opt_out: DEFAULT_OPT_OUT_KEYWORDS,
  opt_in: DEFAULT_OPT_IN_KEYWORDS,
};

const COPY: Record<KeywordAction, { title: string; hint: string; placeholder: string }> = {
  opt_out: {
    title: "Unsubscribe keywords",
    hint: "When a customer sends one of these, we stop marketing to them.",
    placeholder: "e.g. no more",
  },
  opt_in: {
    title: "Resubscribe keywords",
    hint: "When a customer sends one of these, they start receiving updates again.",
    placeholder: "e.g. yes please",
  },
};

export function OptOutKeywordsCard() {
  const { active, canManage } = useOrg();
  const organizationId = active?.organization.id ?? null;

  const [rows, setRows] = useState<KeywordRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  async function add(action: KeywordAction, raw: string): Promise<boolean> {
    if (!organizationId || !rows) return false;
    const value = normalizeKeyword(raw);
    const opposite: KeywordAction = action === "opt_out" ? "opt_in" : "opt_out";

    if (!value) {
      toast.error("Add the word people will send you.");
      return false;
    }
    if (BUILT_INS[opposite].some((k) => normalizeKeyword(k) === value)) {
      toast.error(
        `“${value}” is a built-in ${opposite === "opt_out" ? "unsubscribe" : "resubscribe"} word — it can't do both.`,
      );
      return false;
    }
    if (
      BUILT_INS[action].some((k) => normalizeKeyword(k) === value) ||
      rows.some((r) => r.action === action && normalizeKeyword(r.keyword) === value)
    ) {
      toast.error("That keyword is already in this list.");
      return false;
    }
    if (rows.some((r) => r.action === opposite && normalizeKeyword(r.keyword) === value)) {
      toast.error("That keyword is already used in the other list.");
      return false;
    }

    const { error: err } = await aidwar
      .from("opt_out_keywords")
      .insert({ organization_id: organizationId, keyword: value, action });
    if (err) {
      toast.error(
        err.code === "23505" ? "That keyword already exists." : "Couldn't save this keyword.",
      );
      return false;
    }
    await logActivity("opt_out_keyword_created", organizationId, { action });
    toast.success("Keyword added.");
    await load();
    return true;
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

  return (
    <div className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
          <Ban className="h-5 w-5" />
        </div>
        <div>
          <h2 className="font-heading text-lg font-semibold text-foreground">
            Unsubscribe &amp; resubscribe keywords
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            A keyword only counts when it is the whole message, and capitals don't matter — we send
            one short confirmation each time someone's status actually changes.
          </p>
        </div>
      </div>

      {rows === null ? (
        <div className="mt-6 space-y-2">
          <Skeleton className="h-12 w-full rounded-xl" />
          <Skeleton className="h-12 w-full rounded-xl" />
        </div>
      ) : error ? (
        <p className="mt-6 text-sm text-destructive">{error}</p>
      ) : (
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          {(["opt_out", "opt_in"] as KeywordAction[]).map((action) => (
            <KeywordList
              key={action}
              action={action}
              custom={rows.filter((r) => r.action === action)}
              canManage={canManage}
              onAdd={(value) => add(action, value)}
              onRemove={remove}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function KeywordList({
  action,
  custom,
  canManage,
  onAdd,
  onRemove,
}: {
  action: KeywordAction;
  custom: KeywordRow[];
  canManage: boolean;
  onAdd: (value: string) => Promise<boolean>;
  onRemove: (row: KeywordRow) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const copy = COPY[action];
  const tone =
    action === "opt_out"
      ? "border-destructive/25 bg-destructive/5"
      : "border-primary/25 bg-primary/5";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const ok = await onAdd(value);
    setSaving(false);
    if (ok) setValue("");
  }

  return (
    <section className="rounded-xl border border-border/60 p-4">
      <h3 className="text-sm font-semibold text-foreground">{copy.title}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{copy.hint}</p>

      <ul className="mt-4 space-y-2">
        {BUILT_INS[action].map((k) => (
          <li
            key={`builtin-${k}`}
            className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${tone}`}
          >
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              “{normalizeKeyword(k)}”
            </span>
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
              <Lock className="h-3 w-3" />
              Built-in
            </span>
          </li>
        ))}
        {custom.map((r) => (
          <li
            key={r.id}
            className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/60 px-3 py-2 transition-colors duration-200 hover:border-primary/30"
          >
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              “{r.keyword}”
            </span>
            {canManage ? (
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                onClick={() => void onRemove(r)}
                aria-label={`Remove ${r.keyword}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            ) : null}
          </li>
        ))}
      </ul>

      {canManage ? (
        <form onSubmit={submit} className="mt-4 flex items-end gap-2">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor={`keyword-${action}`} className="text-xs">
              Add your own
            </Label>
            <Input
              id={`keyword-${action}`}
              placeholder={copy.placeholder}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          <Button type="submit" className="rounded-full" disabled={saving}>
            <Plus className="mr-2 h-4 w-4" />
            {saving ? "Adding…" : "Add"}
          </Button>
        </form>
      ) : null}
    </section>
  );
}
