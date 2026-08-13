import { useState } from "react";
import { Building2, Loader2, Sparkles, Users, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { aidwar } from "@/integrations/aidwar/client";

const PERKS = [
  { icon: Sparkles, title: "AI campaigns", copy: "Draft and launch campaigns with AI in minutes." },
  { icon: Users, title: "Shared inbox", copy: "Invite your team and reply together, in one place." },
  { icon: Rocket, title: "Automations", copy: "Follow-ups that keep selling after hours." },
];

export function OrgOnboarding({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (name.trim().length < 2) {
      setError("Please enter a workspace name with at least 2 characters.");
      return;
    }
    setPending(true);
    setError(null);
    const { error: err } = await aidwar.rpc("create_organization", { org_name: name.trim() });
    setPending(false);
    if (err) {
      setError("We couldn't create your workspace. Please try again.");
      return;
    }
    onCreated();
  }

  return (
    <div className="mx-auto grid max-w-5xl gap-10 py-6 lg:grid-cols-[1.1fr_1fr] lg:items-center lg:py-16">
      <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
        <span className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
          <Building2 className="h-3.5 w-3.5" /> Step 1 of 1
        </span>
        <h1 className="mt-4 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
          Name your workspace
        </h1>
        <p className="mt-3 max-w-md text-muted-foreground">
          This is where your contacts, campaigns and team live. You'll be the owner — you can invite
          teammates and rename it any time.
        </p>

        <form onSubmit={onSubmit} className="mt-8 max-w-md space-y-4">
          <div className="space-y-2">
            <Label htmlFor="org_name">Workspace name</Label>
            <Input
              id="org_name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Meezoy Ventures"
              autoFocus
              required
            />
          </div>
          {error ? (
            <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
          ) : null}
          <Button type="submit" className="w-full rounded-full transition-all duration-200" disabled={pending}>
            {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Create workspace
          </Button>
        </form>
      </div>

      <div className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm sm:p-8">
        <p className="text-sm font-semibold text-foreground">What you unlock</p>
        <ul className="mt-5 space-y-5">
          {PERKS.map((p) => (
            <li key={p.title} className="flex gap-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <p.icon className="h-5 w-5" />
              </span>
              <span>
                <span className="block text-sm font-semibold text-foreground">{p.title}</span>
                <span className="block text-sm text-muted-foreground">{p.copy}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
