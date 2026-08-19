import { useEffect, useMemo, useState } from "react";
import { History, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { employeeApi, whenText, type InstructionVersion } from "@/lib/employee-client";
import {
  DEFAULT_LANGUAGES,
  LANGUAGES,
  languageLabel,
  languageName,
  languagesMentioned,
} from "@/lib/languages";

const TONES = [
  { value: "friendly", label: "Friendly" },
  { value: "professional", label: "Professional" },
  { value: "concise", label: "Straight to the point" },
  { value: "warm", label: "Warm and chatty" },
];

const HOURS = [
  { value: "always", label: "Any time of day" },
  { value: "business_hours", label: "Only during working hours" },
  { value: "after_hours_only", label: "Only outside working hours" },
];

const LANGUAGE_OPTIONS = LANGUAGES.map((l) => ({ value: l.code, label: languageLabel(l.code) }));

/** How the employee behaves: who it is, what it must never do, when to fetch a human. */
export function BehaviourEditor({
  organizationId,
  versions,
  canConfigure,
  onChanged,
}: {
  organizationId: string;
  versions: InstructionVersion[];
  canConfigure: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const current = useMemo(
    () => versions.find((v) => v.is_current) ?? versions[0] ?? null,
    [versions],
  );

  const [personaName, setPersonaName] = useState("");
  const [tone, setTone] = useState("friendly");
  const [instructions, setInstructions] = useState("");
  const [escalation, setEscalation] = useState("");
  const [hours, setHours] = useState("always");
  const [languages, setLanguages] = useState<string[]>(DEFAULT_LANGUAGES as string[]);
  const [saving, setSaving] = useState(false);

  // A language named in the brief but switched off is a promise I can't keep.
  const missingLanguages = useMemo(
    () => languagesMentioned(instructions).filter((c) => !languages.includes(c)),
    [instructions, languages],
  );


  useEffect(() => {
    setPersonaName(current?.persona_name ?? "");
    setTone(current?.tone ?? "friendly");
    setInstructions(current?.instructions ?? "");
    setEscalation(current?.escalation_rules ?? "");
    setHours(current?.working_hours_behaviour ?? "always");
    setLanguages(current?.languages?.length ? current.languages : (DEFAULT_LANGUAGES as string[]));
  }, [current]);

  const save = async () => {
    setSaving(true);
    const { error } = await employeeApi({
      organization_id: organizationId,
      action: "save_instructions",
      persona_name: personaName,
      tone,
      instructions,
      escalation_rules: escalation,
      working_hours_behaviour: hours,
      languages,
    });
    setSaving(false);
    if (error) toast.error(error);
    else {
      toast.success("Saved. Every change keeps a version you can go back to.");
      await onChanged();
    }
  };

  const revert = async (id: string) => {
    const { error } = await employeeApi({
      organization_id: organizationId,
      action: "revert_instructions",
      instruction_id: id,
    });
    if (error) toast.error(error);
    else {
      toast.success("Rolled back.");
      await onChanged();
    }
  };

  const toggleLanguage = (value: string) => {
    setLanguages((prev) =>
      prev.includes(value) ? prev.filter((l) => l !== value) || ["en"] : [...prev, value],
    );
  };

  return (
    <section
      aria-labelledby="behaviour-heading"
      className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="behaviour-heading" className="text-lg font-semibold text-foreground">
            How it behaves
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Who it is when it talks to your customers, and when it should step back and fetch a
            person.
          </p>
        </div>
        {current ? <Badge variant="secondary">Version {current.version}</Badge> : null}
      </div>

      <div className="mt-6 grid gap-5 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="persona">What customers should call it</Label>
          <Input
            id="persona"
            value={personaName}
            disabled={!canConfigure}
            onChange={(e) => setPersonaName(e.target.value)}
            placeholder="e.g. Riya from Meezoy"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="tone">How it should sound</Label>
          <Select value={tone} onValueChange={setTone} disabled={!canConfigure}>
            <SelectTrigger id="tone">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TONES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="mt-5 space-y-2">
        <Label htmlFor="instructions">What it should and shouldn't do</Label>
        <Textarea
          id="instructions"
          rows={6}
          value={instructions}
          disabled={!canConfigure}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="We ship across India in 3–5 days. Never promise same-day delivery. Never offer a discount that isn't on the website."
          className="resize-y"
        />
        <p className="text-xs text-muted-foreground">
          Write it like you'd brief a new hire on their first day.
        </p>
      </div>

      <div className="mt-5 space-y-2">
        <Label htmlFor="escalation">When I should fetch a person</Label>
        <Textarea
          id="escalation"
          rows={4}
          value={escalation}
          disabled={!canConfigure}
          onChange={(e) => setEscalation(e.target.value)}
          placeholder="Anything about refunds over ₹5,000, damaged goods, or an angry customer."
          className="resize-y"
        />
      </div>

      <div className="mt-5 grid gap-5 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="hours">When it's allowed to work</Label>
          <Select value={hours} onValueChange={setHours} disabled={!canConfigure}>
            <SelectTrigger id="hours">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HOURS.map((h) => (
                <SelectItem key={h.value} value={h.value}>
                  {h.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-foreground">Languages it may reply in</legend>
          <div className="flex flex-wrap gap-2">
            {LANGUAGE_OPTIONS.map((l) => {
              const on = languages.includes(l.value);
              return (
                <button
                  key={l.value}
                  type="button"
                  disabled={!canConfigure}
                  aria-pressed={on}
                  onClick={() => toggleLanguage(l.value)}
                  className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-all duration-200 disabled:opacity-60 ${
                    on
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border/70 text-muted-foreground hover:border-primary/40"
                  }`}
                >
                  {l.label}
                </button>
              );
            })}
          </div>
          {missingLanguages.length ? (
            <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              Your instructions mention {missingLanguages.map(languageName).join(", ")}, but{" "}
              {missingLanguages.length === 1 ? "it isn't" : "they aren't"} switched on above — so I
              won't reply in {missingLanguages.length === 1 ? "it" : "them"}. Turn{" "}
              {missingLanguages.length === 1 ? "it" : "them"} on, or take the mention out.
            </p>
          ) : null}
        </fieldset>
      </div>

      {canConfigure ? (
        <div className="mt-6 flex items-center gap-3">
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            Save behaviour
          </Button>
        </div>
      ) : (
        <p className="mt-6 text-sm text-muted-foreground">
          You can read this. Changing it needs the "Configure AI" permission.
        </p>
      )}

      {versions.length > 1 ? (
        <div className="mt-8 border-t border-border/70 pt-5">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <History className="h-4 w-4 text-muted-foreground" />
            Earlier versions
          </h3>
          <ul className="mt-3 space-y-2">
            {versions
              .filter((v) => !v.is_current)
              .slice(0, 8)
              .map((v) => (
                <li
                  key={v.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-muted/30 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">Version {v.version}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {whenText(v.updated_at)} · {v.persona_name || "Unnamed"}
                    </p>
                  </div>
                  {canConfigure ? (
                    <Button size="sm" variant="outline" onClick={() => void revert(v.id)}>
                      Go back to this
                    </Button>
                  ) : null}
                </li>
              ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
