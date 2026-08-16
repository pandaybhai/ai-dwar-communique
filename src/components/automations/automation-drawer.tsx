import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { logActivity } from "@/lib/activity";
import { formatDate } from "@/lib/contacts";
import {
  DEFAULT_OPT_IN_KEYWORDS,
  DEFAULT_OPT_OUT_KEYWORDS,
  normalizeKeyword,
} from "@/lib/opt-out";
import {
  DAY_LABELS,
  MESSAGE_MAX,
  TRIGGER_DESCRIPTIONS,
  TRIGGER_LABELS,
  normalizeConfig,
  skipLabel,
  type AutomationRow,
  type AutomationRunRow,
  type TriggerType,
} from "@/lib/automations";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

const TRIGGERS: TriggerType[] = ["welcome", "keyword", "away"];

export function AutomationDrawer({
  open,
  automation,
  organizationId,
  canManage,
  onClose,
  onSaved,
}: {
  open: boolean;
  automation: AutomationRow | null;
  organizationId: string;
  canManage: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [triggerType, setTriggerType] = useState<TriggerType>("welcome");
  const [priority, setPriority] = useState(100);
  const [isActive, setIsActive] = useState(false);
  const [body, setBody] = useState("");
  const [keywords, setKeywords] = useState<string[]>([]);
  const [keywordDraft, setKeywordDraft] = useState("");
  const [matchMode, setMatchMode] = useState<"exact" | "contains">("exact");
  const [days, setDays] = useState<number[]>([]);
  const [start, setStart] = useState("18:00");
  const [end, setEnd] = useState("09:00");
  const [saving, setSaving] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const [optKeywords, setOptKeywords] = useState<{ keyword: string; action: string }[]>([]);
  const [runs, setRuns] = useState<AutomationRunRow[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setErrorText(null);
    setKeywordDraft("");
    const config = normalizeConfig(
      (automation?.trigger_type as TriggerType) ?? "welcome",
      automation?.config,
    );
    setName(automation?.name ?? "");
    setTriggerType((automation?.trigger_type as TriggerType) ?? "welcome");
    setPriority(automation?.priority ?? 100);
    setIsActive(automation?.is_active ?? false);
    setBody(automation?.message_body ?? "");
    setKeywords(config.keywords ?? []);
    setMatchMode(config.match === "contains" ? "contains" : "exact");
    setDays(config.days ?? [1, 2, 3, 4, 5]);
    setStart(config.start ?? "18:00");
    setEnd(config.end ?? "09:00");
  }, [open, automation]);

  const loadMeta = useCallback(async () => {
    if (!open) return;
    const { data } = await aidwar
      .from("opt_out_keywords")
      .select("keyword, action")
      .eq("organization_id", organizationId);
    setOptKeywords((data as { keyword: string; action: string }[]) ?? []);

    if (automation?.id) {
      setRuns(null);
      const { data: runRows } = await aidwar
        .from("automation_runs")
        .select("id, automation_id, contact_id, inbound_message_id, status, skip_reason, error, created_at")
        .eq("automation_id", automation.id)
        .order("created_at", { ascending: false })
        .limit(20);
      setRuns((runRows as AutomationRunRow[]) ?? []);
    } else {
      setRuns([]);
    }
  }, [open, organizationId, automation]);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  /** Built-in + custom opt-out / opt-in keywords, normalised for comparison. */
  const reserved = useMemo(() => {
    const map = new Map<string, string>();
    for (const k of DEFAULT_OPT_OUT_KEYWORDS) map.set(normalizeKeyword(k), "built-in unsubscribe keyword");
    for (const k of DEFAULT_OPT_IN_KEYWORDS) map.set(normalizeKeyword(k), "built-in resubscribe keyword");
    for (const row of optKeywords) {
      map.set(
        normalizeKeyword(row.keyword),
        row.action === "opt_in" ? "your resubscribe keyword" : "your unsubscribe keyword",
      );
    }
    return map;
  }, [optKeywords]);

  function addKeyword() {
    const value = normalizeKeyword(keywordDraft);
    if (!value) {
      setErrorText("Enter a keyword first.");
      return;
    }
    const conflict = reserved.get(value);
    if (conflict) {
      setErrorText(`"${value}" is ${conflict} — pick a different keyword.`);
      return;
    }
    if (keywords.includes(value)) {
      setErrorText(`"${value}" is already in this list.`);
      return;
    }
    setKeywords((prev) => [...prev, value]);
    setKeywordDraft("");
    setErrorText(null);
  }

  async function save() {
    setErrorText(null);
    if (!name.trim()) return setErrorText("Give this automation a name.");
    if (!body.trim()) return setErrorText("Write the message this automation should send.");
    if (body.length > MESSAGE_MAX) return setErrorText(`Message must be under ${MESSAGE_MAX} characters.`);

    if (triggerType === "keyword") {
      if (!keywords.length) return setErrorText("Add at least one keyword.");
      for (const k of keywords) {
        const conflict = reserved.get(k);
        if (conflict) return setErrorText(`"${k}" is ${conflict} — remove it before saving.`);
      }
    }
    if (triggerType === "away" && !days.length) {
      return setErrorText("Pick at least one day for the away window.");
    }

    const config =
      triggerType === "keyword"
        ? { keywords, match: matchMode }
        : triggerType === "away"
          ? { days: [...days].sort(), start, end }
          : {};

    setSaving(true);
    const payload = {
      organization_id: organizationId,
      name: name.trim(),
      trigger_type: triggerType,
      is_active: isActive,
      priority,
      config,
      message_body: body,
      updated_at: new Date().toISOString(),
    };

    const { data: userData } = await aidwar.auth.getUser();
    const { error } = automation?.id
      ? await aidwar.from("automations").update(payload).eq("id", automation.id)
      : await aidwar
          .from("automations")
          .insert({ ...payload, created_by: userData.user?.id ?? null });
    setSaving(false);

    if (error) {
      setErrorText("We couldn't save this automation. Please try again.");
      return;
    }
    void logActivity(
      automation?.id ? "automation_updated" : "automation_created",
      organizationId,
      { name: payload.name, trigger_type: triggerType, is_active: isActive },
    );
    toast.success(automation?.id ? "Automation saved." : "Automation created.");
    onSaved();
    onClose();
  }

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{automation?.id ? "Edit automation" : "New automation"}</SheetTitle>
        </SheetHeader>

        <div className="space-y-6 px-4 pb-10">
          <div className="space-y-2">
            <Label htmlFor="automation-name">Name</Label>
            <Input
              id="automation-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Welcome new enquiries"
              disabled={!canManage}
            />
          </div>

          <div className="space-y-2">
            <Label>Trigger</Label>
            <Select
              value={triggerType}
              onValueChange={(v) => setTriggerType(v as TriggerType)}
              disabled={!canManage}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRIGGERS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TRIGGER_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{TRIGGER_DESCRIPTIONS[triggerType]}</p>
          </div>

          {triggerType === "keyword" ? (
            <div className="space-y-3 rounded-xl border border-border/70 bg-muted/30 p-4">
              <Label>Keywords</Label>
              <p className="text-xs text-muted-foreground">
                Keywords are matched case-insensitively, with punctuation and extra spaces removed —
                exactly like the unsubscribe matcher.
              </p>
              <div className="flex flex-wrap gap-2">
                {keywords.map((k) => (
                  <span
                    key={k}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1 text-xs font-medium"
                  >
                    {k}
                    {canManage ? (
                      <button
                        type="button"
                        aria-label={`Remove ${k}`}
                        onClick={() => setKeywords((prev) => prev.filter((x) => x !== k))}
                        className="text-muted-foreground transition-colors hover:text-destructive"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    ) : null}
                  </span>
                ))}
                {!keywords.length ? (
                  <span className="text-xs text-muted-foreground">No keywords yet.</span>
                ) : null}
              </div>
              {canManage ? (
                <div className="flex gap-2">
                  <Input
                    value={keywordDraft}
                    onChange={(e) => setKeywordDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addKeyword();
                      }
                    }}
                    placeholder="e.g. price"
                  />
                  <Button type="button" variant="outline" onClick={addKeyword}>
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              ) : null}
              <div className="space-y-2">
                <Label>Match</Label>
                <Select
                  value={matchMode}
                  onValueChange={(v) => setMatchMode(v as "exact" | "contains")}
                  disabled={!canManage}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="exact">Whole message matches the keyword</SelectItem>
                    <SelectItem value="contains">Message contains the keyword</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : null}

          {triggerType === "away" ? (
            <div className="space-y-3 rounded-xl border border-border/70 bg-muted/30 p-4">
              <Label>Away days</Label>
              <div className="flex flex-wrap gap-2">
                {DAY_LABELS.map((label, index) => {
                  const on = days.includes(index);
                  return (
                    <button
                      key={label}
                      type="button"
                      disabled={!canManage}
                      onClick={() =>
                        setDays((prev) =>
                          prev.includes(index)
                            ? prev.filter((d) => d !== index)
                            : [...prev, index],
                        )
                      }
                      className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-all duration-200 ${
                        on
                          ? "border-primary/30 bg-primary/10 text-primary"
                          : "border-border bg-background text-muted-foreground hover:border-primary/30"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="away-start">From</Label>
                  <Input
                    id="away-start"
                    type="time"
                    value={start}
                    onChange={(e) => setStart(e.target.value)}
                    disabled={!canManage}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="away-end">To</Label>
                  <Input
                    id="away-end"
                    type="time"
                    value={end}
                    onChange={(e) => setEnd(e.target.value)}
                    disabled={!canManage}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Times use your workspace timezone. Overnight windows are supported. One reply per
                contact every 4 hours.
              </p>
            </div>
          ) : null}

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="automation-body">Message</Label>
              <span
                className={`text-xs ${body.length > MESSAGE_MAX ? "text-destructive" : "text-muted-foreground"}`}
              >
                {body.length}/{MESSAGE_MAX}
              </span>
            </div>
            <Textarea
              id="automation-body"
              rows={5}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Hi! Thanks for reaching out — we'll get back to you shortly."
              disabled={!canManage}
            />
            <p className="text-xs text-muted-foreground">
              Sent as a plain message inside the 24-hour service window — never a template.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="automation-priority">Priority</Label>
              <Input
                id="automation-priority"
                type="number"
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value) || 0)}
                disabled={!canManage}
              />
              <p className="text-xs text-muted-foreground">Lower fires first.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="automation-active">Active</Label>
              <div className="flex h-10 items-center gap-3">
                <Switch
                  id="automation-active"
                  checked={isActive}
                  onCheckedChange={setIsActive}
                  disabled={!canManage}
                />
                <span className="text-sm text-muted-foreground">
                  {isActive ? "Running" : "Paused"}
                </span>
              </div>
            </div>
          </div>

          {errorText ? (
            <div className="flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/5 p-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{errorText}</span>
            </div>
          ) : null}

          {canManage ? (
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose} className="rounded-full">
                Cancel
              </Button>
              <Button onClick={() => void save()} disabled={saving} className="rounded-full">
                {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {automation?.id ? "Save changes" : "Create automation"}
              </Button>
            </div>
          ) : null}

          {automation?.id ? (
            <div className="space-y-3 border-t border-border/70 pt-6">
              <h3 className="text-sm font-semibold text-foreground">Recent runs</h3>
              {runs === null ? (
                <div className="space-y-2">
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </div>
              ) : runs.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
                  No runs yet. Every evaluation — including skips — will appear here.
                </p>
              ) : (
                <ul className="space-y-2">
                  {runs.map((run) => (
                    <li
                      key={run.id}
                      className="flex items-start justify-between gap-3 rounded-xl border border-border/70 bg-card p-3 text-sm"
                    >
                      <div>
                        <span
                          className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${
                            run.status === "sent"
                              ? "border-primary/25 bg-primary/10 text-primary"
                              : run.status === "failed"
                                ? "border-destructive/25 bg-destructive/10 text-destructive"
                                : "border-border bg-muted text-muted-foreground"
                          }`}
                        >
                          {run.status}
                        </span>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {run.status === "sent"
                            ? "Reply sent"
                            : skipLabel(run.skip_reason ?? run.error)}
                        </p>
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatDate(run.created_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
