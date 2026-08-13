import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { LogOut, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { aidwar } from "@/integrations/aidwar/client";

type Profile = { full_name: string | null; email: string | null };

export const Route = createFileRoute("/app/")({
  head: () => ({
    meta: [
      { title: "Dashboard — AiDwar" },
      { name: "description", content: "Your AiDwar workspace dashboard." },
      { property: "og:title", content: "Dashboard — AiDwar" },
      { property: "og:description", content: "Your AiDwar workspace dashboard." },
    ],
  }),
  component: AppHome,
});

function AppHome() {
  const navigate = useNavigate();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data: userData } = await aidwar.auth.getUser();
      const id = userData.user?.id;
      if (!id) return;
      const { data, error: err } = await aidwar
        .from("profiles")
        .select("full_name, email")
        .eq("id", id)
        .maybeSingle();
      if (!active) return;
      if (err) setError("We couldn't load your profile. Please refresh.");
      else setProfile((data as Profile) ?? { full_name: null, email: userData.user?.email ?? null });
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, []);

  async function signOut() {
    setSigningOut(true);
    await aidwar.auth.signOut();
    navigate({ to: "/login", replace: true });
  }

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="border-b border-border/70 bg-background">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 sm:px-8">
          <span className="text-xl font-bold tracking-tight text-foreground">
            Ai<span className="text-primary">Dwar</span>
          </span>
          <Button variant="outline" size="sm" className="rounded-full" onClick={signOut} disabled={signingOut}>
            {signingOut ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <LogOut className="mr-2 h-4 w-4" />}
            Log out
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-12 sm:px-8">
        {loading ? (
          <div className="space-y-4">
            <div className="h-8 w-64 animate-pulse rounded-lg bg-muted" />
            <div className="h-32 w-full animate-pulse rounded-2xl bg-muted" />
          </div>
        ) : error ? (
          <div className="rounded-2xl border border-destructive/20 bg-destructive/5 p-6 text-sm text-destructive">
            {error}
          </div>
        ) : (
          <>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">
              Welcome{profile?.full_name ? `, ${profile.full_name.split(" ")[0]}` : ""}
            </h1>
            <p className="mt-2 text-muted-foreground">
              Your workspace is ready. Campaigns, contacts and the shared inbox arrive next.
            </p>
            <div className="mt-8 rounded-2xl border border-border/70 bg-card p-8 text-center shadow-sm">
              <p className="text-base font-semibold text-foreground">Nothing here yet</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                We're setting up your account. You'll be able to connect your business messaging account and
                launch your first campaign shortly.
              </p>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
