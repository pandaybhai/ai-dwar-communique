import { createFileRoute, Link, useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Building2, Loader2 } from "lucide-react";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { aidwar } from "@/integrations/aidwar/client";

const TITLE = "Join a workspace — AiDwar";
const DESCRIPTION = "Accept your AiDwar team invitation and join your organization's workspace.";

export const Route = createFileRoute("/join/$token")({
  ssr: false,
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
    ],
  }),
  component: JoinPage,
});

type Preview = { organization_name: string; role: string; expired: boolean; accepted: boolean };

function JoinPage() {
  const { token } = useParams({ from: "/join/$token" });
  const navigate = useNavigate();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(true);
  const [signedIn, setSignedIn] = useState(false);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [{ data }, { data: session }] = await Promise.all([
        aidwar.rpc("invitation_preview", { invite_token: token }),
        aidwar.auth.getSession(),
      ]);
      const row = (data as Preview[] | null)?.[0] ?? null;
      setPreview(row);
      setSignedIn(Boolean(session.session));
      if (!row) setError("This invite link isn't valid.");
      else if (row.accepted) setError("This invite has already been used.");
      else if (row.expired) setError("This invite has expired. Ask your admin for a new link.");
      setLoading(false);
    })();
  }, [token]);

  async function join() {
    setJoining(true);
    setError(null);
    const { error: err } = await aidwar.rpc("accept_invitation", { invite_token: token });
    setJoining(false);
    if (err) {
      setError(err.message || "We couldn't accept this invite.");
      return;
    }
    navigate({ to: "/app/inbox", replace: true });
  }

  const redirectPath = `/join/${token}`;

  return (
    <AuthShell
      title="You've been invited"
      subtitle="Accept this invitation to join your team's AiDwar workspace."
      footer={
        <>
          Wrong account?{" "}
          <Link to="/login" className="font-medium text-primary hover:underline">
            Log in as someone else
          </Link>
        </>
      }
    >
      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-10 w-full rounded-full" />
        </div>
      ) : error ? (
        <div className="space-y-4">
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
          <Button asChild variant="outline" className="w-full rounded-full">
            <Link to="/">Back to home</Link>
          </Button>
        </div>
      ) : preview ? (
        <div className="space-y-5">
          <div className="flex items-center gap-3 rounded-xl border border-border/70 bg-muted/40 p-4">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Building2 className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-foreground">{preview.organization_name}</p>
              <p className="text-xs capitalize text-muted-foreground">Joining as {preview.role}</p>
            </div>
          </div>

          {signedIn ? (
            <Button className="w-full rounded-full" onClick={join} disabled={joining}>
              {joining ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Accept invitation
            </Button>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Log in or create an account with your invited email to join this workspace.
              </p>
              <Button asChild className="w-full rounded-full">
                <Link to="/signup" search={{ redirect: redirectPath }}>
                  Create an account
                </Link>
              </Button>
              <Button asChild variant="outline" className="w-full rounded-full">
                <Link to="/login" search={{ redirect: redirectPath }}>
                  Log in
                </Link>
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </AuthShell>
  );
}
