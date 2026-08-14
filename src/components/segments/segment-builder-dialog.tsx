import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Sparkles, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { callApi } from "@/lib/whatsapp-client";
import { logActivity } from "@/lib/activity";
import { contactInitials, type TagRow } from "@/lib/contacts";
import {
  FIELD_LABELS,
  FIELD_OPERATORS,
  NO_VALUE_OPERATORS,
  emptyFilters,
  newCondition,
  usableConditions,
  type SegmentCondition,
  type SegmentField,
  type SegmentFilters,
  type SegmentRow,
} from "@/lib/segments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type PreviewContact = {
  id: string;
  name: string | null;
  phone: string;
  created_at: string;
};

export function SegmentBuilderDialog({
  organizationId,
  tags,
  attributeKeys,
  open,
  onOpenChange,
  segment,
  initialName,
  onSaved,
}: {
  organizationId: string;
  tags: TagRow[];
  attributeKeys: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  segment?: SegmentRow | null;
  initialName?: string;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [filters, setFilters] = useState<SegmentFilters>(emptyFilters());
  const [saving, setSaving] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [preview, setPreview] = useState<PreviewContact[]>([]);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(initialName ?? segment?.name ?? "");
    setDescription(segment?.description ?? "");
    setFilters(
      segment?.filters?.conditions
        ? { match: segment.filters.match ?? "all", conditions: [...segment.filters.conditions] }
        : { match: "all", conditions: [newCondition()] },
    );
    setCount(null);
    setPreview([]);
  }, [open, segment, initialName]);

  const runPreview = useCallback(async () => {
    setPreviewing(true);
    const { data } = await callApi<{ count: number; preview: PreviewContact[] }>(
      "/api/contacts/evaluate-segment",
      { body: { organization_id: organizationId, filters } },
    );
    setPreviewing(false);
    if (data) {
      setCount(data.count);
      setPreview(data.preview);
    }
  }, [organizationId, filters]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => void runPreview(), 400);
    return () => clearTimeout(t);
  }, [open, runPreview]);

  const ready = useMemo(() => usableConditions(filters).length, [filters]);

  function update(index: number, patch: Partial<SegmentCondition>) {
    setFilters((f) => ({
      ...f,
      conditions: f.conditions.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    }));
  }

  function changeField(index: number, field: SegmentField) {
    update(index, {
      field,
      operator: FIELD_OPERATORS[field][0]!.value,
      value: "",
      value2: "",
      key: field === "attribute" ? (attributeKeys[0] ?? "") : undefined,
    });
  }

  async function save() {
    if (!name.trim()) {
      toast.error("Give this segment a name.");
      return;
    }
    setSaving(true);
    const payload = {
      organization_id: organizationId,
      name: name.trim(),
      description: description.trim() || null,
      filters: { match: filters.match, conditions: usableConditions(filters) },
    };
    const { data: userData } = await aidwar.auth.getUser();
    const res = segment
      ? await aidwar.from("segments").update(payload).eq("id", segment.id)
      : await aidwar.from("segments").insert({ ...payload, created_by: userData.user?.id ?? null });
    setSaving(false);
    if (res.error) {
      toast.error(
        res.error.code === "23505"
          ? "A segment with that name already exists."
          : "We couldn't save this segment. Please try again.",
      );
      return;
    }
    if (!segment) {
      void logActivity("segment_created", organizationId, {
        name: payload.name,
        conditions: payload.filters.conditions.length,
        match: payload.filters.match,
      });
    }
    toast.success(segment ? "Segment updated." : "Segment created.");
    onOpenChange(false);
    onSaved();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{segment ? "Edit segment" : "New segment"}</DialogTitle>
          <DialogDescription>
            Segments stay live — contacts move in and out automatically as they match.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="segment-name">Name</Label>
                <Input
                  id="segment-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="VIP buyers in Mumbai"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="segment-description">Description</Label>
                <Input
                  id="segment-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Optional — what this group is for"
                />
              </div>
            </div>

            <div className="rounded-2xl border border-border/70 bg-muted/30 p-4">
              <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
                <span className="text-muted-foreground">Include contacts matching</span>
                <div className="inline-flex rounded-full border border-border bg-background p-0.5">
                  {(["all", "any"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setFilters((f) => ({ ...f, match: m }))}
                      className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors duration-150 ${
                        filters.match === m
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {m === "all" ? "all conditions" : "any condition"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-3">
                {filters.conditions.map((c, i) => (
                  <div
                    key={i}
                    className="flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-background p-3"
                  >
                    <Select
                      value={c.field}
                      onValueChange={(v) => changeField(i, v as SegmentField)}
                    >
                      <SelectTrigger className="w-full sm:w-44">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(FIELD_LABELS) as SegmentField[]).map((f) => (
                          <SelectItem key={f} value={f}>
                            {FIELD_LABELS[f]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    {c.field === "attribute" ? (
                      attributeKeys.length ? (
                        <Select
                          value={c.key ?? ""}
                          onValueChange={(v) => update(i, { key: v })}
                        >
                          <SelectTrigger className="w-full sm:w-40">
                            <SelectValue placeholder="Attribute" />
                          </SelectTrigger>
                          <SelectContent>
                            {attributeKeys.map((k) => (
                              <SelectItem key={k} value={k}>
                                {k}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          No custom attributes yet
                        </span>
                      )
                    ) : null}

                    <Select value={c.operator} onValueChange={(v) => update(i, { operator: v })}>
                      <SelectTrigger className="w-full sm:w-40">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FIELD_OPERATORS[c.field].map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    <ValueInput
                      condition={c}
                      tags={tags}
                      onChange={(patch) => update(i, patch)}
                    />

                    <Button
                      variant="ghost"
                      size="icon"
                      className="ml-auto text-muted-foreground hover:text-destructive"
                      onClick={() =>
                        setFilters((f) => ({
                          ...f,
                          conditions: f.conditions.filter((_, idx) => idx !== i),
                        }))
                      }
                      aria-label="Remove condition"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>

              <Button
                variant="ghost"
                className="mt-3 rounded-full"
                onClick={() =>
                  setFilters((f) => ({ ...f, conditions: [...f.conditions, newCondition()] }))
                }
              >
                <Plus className="mr-2 h-4 w-4" />
                Add condition
              </Button>
            </div>
          </div>

          <div className="rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/10 to-primary/5 p-5">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Sparkles className="h-4 w-4 text-primary" />
              Live preview
            </div>
            <div className="mt-4">
              {previewing && count === null ? (
                <Skeleton className="h-10 w-24" />
              ) : (
                <div className="text-3xl font-bold text-foreground transition-all duration-200">
                  {count ?? 0}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {ready ? "contacts match right now" : "contacts — add a condition to narrow this"}
              </p>
            </div>

            <div className="mt-5 space-y-2">
              {previewing && !preview.length ? (
                <>
                  <Skeleton className="h-10 w-full rounded-xl" />
                  <Skeleton className="h-10 w-full rounded-xl" />
                </>
              ) : preview.length ? (
                preview.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center gap-3 rounded-xl bg-background/70 p-2"
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-[11px] font-semibold text-primary">
                      {contactInitials({ name: c.name, phone: c.phone })}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-foreground">
                        {c.name || "Unnamed contact"}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">{c.phone}</p>
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-xl border border-dashed border-border bg-background/50 p-4 text-center text-xs text-muted-foreground">
                  <Users className="mx-auto mb-2 h-5 w-5 text-muted-foreground" />
                  No contacts match these conditions yet.
                </div>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className="rounded-full" onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : segment ? "Save changes" : "Create segment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ValueInput({
  condition,
  tags,
  onChange,
}: {
  condition: SegmentCondition;
  tags: TagRow[];
  onChange: (patch: Partial<SegmentCondition>) => void;
}) {
  if (NO_VALUE_OPERATORS.has(condition.operator)) return null;

  if (condition.field === "tag") {
    return (
      <Select value={condition.value ?? ""} onValueChange={(v) => onChange({ value: v })}>
        <SelectTrigger className="w-full sm:w-44">
          <SelectValue placeholder="Choose a tag" />
        </SelectTrigger>
        <SelectContent>
          {tags.map((t) => (
            <SelectItem key={t.id} value={t.id}>
              {t.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (condition.field === "opt_in_status") {
    return (
      <Select value={condition.value ?? ""} onValueChange={(v) => onChange({ value: v })}>
        <SelectTrigger className="w-full sm:w-40">
          <SelectValue placeholder="Choose status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="opted_in">Opted in</SelectItem>
          <SelectItem value="opted_out">Opted out</SelectItem>
          <SelectItem value="unknown">Unknown</SelectItem>
        </SelectContent>
      </Select>
    );
  }

  const isDate =
    condition.field === "created_at" ||
    condition.operator === "date_before" ||
    condition.operator === "date_after";

  if (condition.field === "created_at" && condition.operator === "between") {
    return (
      <div className="flex items-center gap-2">
        <Input
          type="date"
          className="w-36"
          value={condition.value ?? ""}
          onChange={(e) => onChange({ value: e.target.value })}
        />
        <span className="text-xs text-muted-foreground">and</span>
        <Input
          type="date"
          className="w-36"
          value={condition.value2 ?? ""}
          onChange={(e) => onChange({ value2: e.target.value })}
        />
      </div>
    );
  }

  return (
    <Input
      type={isDate ? "date" : "text"}
      className="w-full sm:w-48"
      placeholder={isDate ? "" : "Value"}
      value={condition.value ?? ""}
      onChange={(e) => onChange({ value: e.target.value })}
    />
  );
}
