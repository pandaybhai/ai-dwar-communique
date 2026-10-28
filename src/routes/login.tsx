import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { AuthShell } from "@/components/auth-shell";
import { PrimaryAction } from "@/components/onboarding/journey-shell";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { aidwar } from "@/integrations/aidwar/client";
import { logActivity } from "@/lib/activity";

const TITLE = "Log in — AiDwar";
const DESCRIPTION = "Log in to your AiDwar workspace to manage campaigns, contacts and conversations.";

export const Route = createFileRoute("/login")({
  ssr: false,
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => {
    const r = search["redirect"];
    return typeof r === "string" && r.startsWith("/") ? { redirect: r } : {};
  },
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
    ],
  }),
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const { redirect } = Route.useSearch();
  const goNext = () =>
    redirect ? navigate({ href: redirect, replace: true }) : navigate({ to: "/app", replace: true });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    aidwar.auth.getSession().then(({ data }) => {
      if (data.session) void goNext();
    });
  }, [redirect]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    const { error: err } = await aidwar.auth.signInWithPassword({
      email: String(form.get("email") ?? "").trim(),
      password: String(form.get("password") ?? ""),
    });
    setPending(false);
    if (err) {
      setError(err.message);
      return;
    }
    await logActivity("user.logged_in", null, { method: "password" });
    void goNext();
  }

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Log in to your AiDwar workspace."
      footer={
        <>
          New to AiDwar?{" "}
          <Link to="/signup" className="font-medium text-primary-strong hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Work email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required placeholder="you@company.com" className="h-12 rounded-xl text-base" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input id="password" name="password" type="password" autoComplete="current-password" required className="h-12 rounded-xl text-base" />
        </div>
        {error ? (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
        ) : null}
        <PrimaryAction type="submit" className="!w-full" disabled={pending}>
          {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          Log in
        </PrimaryAction>
      </form>
    </AuthShell>
  );
}
