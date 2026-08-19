import { useCallback, useEffect, useState } from "react";
import { Briefcase, CheckCircle2, Loader2, Lock, Pencil, Plus, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { employeeApi, type EmployeeSkill } from "@/lib/employee-client";

type Editing = { skill: EmployeeSkill | null; open: boolean };

/**
 * The employee's job description, in the merchant's words. A job it cannot
 * actually do says what is missing and where to fix it — never a dead end.
 */
export function SkillsManager({
  organizationId,
  agentName,
  canConfigure,
  onChanged,
}: {
  organizationId: string;
  agentName: string;
  canConfigure: boolean;
  onChanged?: () => void | Promise<void>;
}) {
  const [skills, setSkills] = useState<EmployeeSkill[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>({ skill: null, open: false });
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", use_when: "", do_not_use_when: "" });

  const load = useCallback(async () => {
    const { data, error } = await employeeApi<{ skills: EmployeeSkill[] }>({
      organization_id: organizationId,
      action: "skills",
    });
    if (error) toast.error(error);
    setSkills(data?.skills ?? []);
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (body: Record<string, unknown>, key: string) => {
    setBusy(key);
    const { error } = await employeeApi({ organization_id: organizationId, ...body });
    setBusy(null);
    if (error) {
      toast.error(error);
      return false;
    }
    await load();
    await onChanged?.();
    return true;
  };

  if (!skills) {
    return (
      <section className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm">
        <Skeleton className="h-6 w-56" />
        <div className="mt-6 grid gap-3 md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
      </section>
    );
  }

  const doable = skills.filter((s) => s.enabled && s.ready).length;

  return (
    <section
      aria-labelledby="skills-heading"
      className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="skills-heading"
            className="flex items-center gap-2 text-lg font-semibold text-foreground"
          >
            <Briefcase className="h-5 w-5 text-primary" />
            What {agentName}'s job is
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {agentName} can do {doable} of {skills.length} jobs. Only the jobs switched on and ready
            are part of how I answer.
          </p>
        </div>
        {canConfigure ? (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            Add a job
          </Button>
        ) : null}
      </div>

      <ul className="mt-6 grid gap-3 md:grid-cols-2">
        {skills.map((skill) => {
          const state = !skill.enabled ? "off" : skill.ready ? "ready" : "blocked";
          return (
            <li
              key={skill.id}
              className={`rounded-xl border p-4 transition-all duration-200 ${
                state === "ready"
                  ? "border-border/70 bg-muted/20"
                  : state === "blocked"
                    ? "border-amber-300/70 bg-amber-50/60 dark:border-amber-900/50 dark:bg-amber-950/20"
                    : "border-dashed border-border/60 bg-muted/10"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    {skill.name}
                    {skill.locked ? <Lock className="h-3.5 w-3.5 text-muted-foreground" /> : null}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">{skill.use_when}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {busy === skill.id ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  <Switch
                    checked={skill.enabled}
                    disabled={!canConfigure || skill.locked || busy === skill.id}
                    aria-label={`Switch ${skill.name} on or off`}
                    onCheckedChange={(v) =>
                      void save({ action: "save_skill", skill_id: skill.id, enabled: v }, skill.id)
                    }
                  />
                </div>
              </div>

              <div className="mt-3 text-xs">
                {state === "ready" ? (
                  <p className="flex items-center gap-1.5 font-medium text-primary">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Ready — {agentName} handles this.
                  </p>
                ) : state === "off" ? (
                  <p className="text-muted-foreground">
                    You've switched this off. {agentName} will hand these to a person.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {skill.missing.map((m) => (
                      <p key={m.text} className="flex flex-wrap items-center gap-2 text-amber-900 dark:text-amber-200">
                        <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
                        <span>
                          {agentName} can't do this yet — {m.text}.
                        </span>
                        {m.href ? (
                          <Button asChild size="sm" variant="outline" className="h-6 px-2 text-[11px]">
                            <a href={m.href}>{m.action ?? "Fix this"}</a>
                          </Button>
                        ) : null}
                      </p>
                    ))}
                  </div>
                )}
              </div>

              {canConfigure ? (
                <div className="mt-3 flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => setEditing({ skill, open: true })}
                  >
                    <Pencil className="mr-1 h-3.5 w-3.5" />
                    Edit wording
                  </Button>
                  {skill.is_custom ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                      onClick={() =>
                        void save({ action: "delete_skill", skill_id: skill.id }, skill.id)
                      }
                    >
                      <Trash2 className="mr-1 h-3.5 w-3.5" />
                      Remove
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <SkillDialog
        title={`Edit "${editing.skill?.name ?? ""}"`}
        open={editing.open}
        agentName={agentName}
        initial={
          editing.skill
            ? {
                name: editing.skill.name,
                use_when: editing.skill.use_when,
                do_not_use_when: editing.skill.do_not_use_when,
              }
            : null
        }
        onClose={() => setEditing({ skill: null, open: false })}
        onSave={async (values) => {
          if (!editing.skill) return;
          const ok = await save(
            { action: "save_skill", skill_id: editing.skill.id, ...values },
            editing.skill.id,
          );
          if (ok) {
            toast.success("Saved.");
            setEditing({ skill: null, open: false });
          }
        }}
      />

      <SkillDialog
        title="Add a job"
        open={adding}
        agentName={agentName}
        initial={form}
        onClose={() => {
          setAdding(false);
          setForm({ name: "", use_when: "", do_not_use_when: "" });
        }}
        onSave={async (values) => {
          const ok = await save({ action: "add_skill", ...values }, "new");
          if (ok) {
            toast.success("Added.");
            setAdding(false);
            setForm({ name: "", use_when: "", do_not_use_when: "" });
          }
        }}
      />
    </section>
  );
}

function SkillDialog({
  title,
  open,
  agentName,
  initial,
  onClose,
  onSave,
}: {
  title: string;
  open: boolean;
  agentName: string;
  initial: { name: string; use_when: string; do_not_use_when: string } | null;
  onClose: () => void;
  onSave: (values: { name: string; use_when: string; do_not_use_when: string }) => Promise<void>;
}) {
  const [values, setValues] = useState({ name: "", use_when: "", do_not_use_when: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setValues(initial ?? { name: "", use_when: "", do_not_use_when: "" });
  }, [open, initial]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Tell {agentName} when this job applies, and when it doesn't. Plain words work best.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="skill-name">Name</Label>
            <Input
              id="skill-name"
              value={values.name}
              onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
              placeholder="Booking a fitting appointment"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="skill-use">Use this when</Label>
            <Textarea
              id="skill-use"
              rows={2}
              value={values.use_when}
              onChange={(e) => setValues((v) => ({ ...v, use_when: e.target.value }))}
              placeholder="The customer asks to visit the store or try something on."
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="skill-avoid">Don't use this when</Label>
            <Textarea
              id="skill-avoid"
              rows={2}
              value={values.do_not_use_when}
              onChange={(e) => setValues((v) => ({ ...v, do_not_use_when: e.target.value }))}
              placeholder="They're asking about an order they already placed."
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={saving || !values.name.trim()}
            onClick={async () => {
              setSaving(true);
              await onSave(values);
              setSaving(false);
            }}
          >
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
