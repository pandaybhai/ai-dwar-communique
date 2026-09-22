import { useCallback, useEffect, useState } from "react";
import { BookOpenCheck, MessageCircle, X } from "lucide-react";
import { toast } from "sonner";
import { AidenHandoff } from "@/components/aiden-handoff";
import { isReading, ReadingBar, ReadingLine } from "@/components/employee/knowledge-manager";
import { Button } from "@/components/ui/button";
import { knowledgeApi, type KnowledgeSource } from "@/lib/employee-client";
import { callApi } from "@/lib/whatsapp-client";

type Handoff = { code: string; wa_link: string; show_setup?: boolean };

const DISMISS_KEY = (sourceId: string) => `aidwar.read-done.${sourceId}`;
/** A finish is only news for a day. */
const FRESH_MS = 24 * 60 * 60 * 1000;

function isFresh(iso: string | null | undefined): boolean {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() < FRESH_MS;
}

/**
 * Owners who closed the sign-up screen before saying hello lose their code.
 * This puts it back in front of them until the step is actually done — there
 * is no dismiss, it disappears by finishing.
 *
 * The same card is also where reading is shown: while a website is being read
 * the reading banner takes the place of the setup card, so the two never
 * appear together.
 */
export function AidenSetupCard({
  organizationId,
  showFinished = false,
}: {
  organizationId: string | null;
  /** Home also carries the "finished reading" card; the employee page doesn't. */
  showFinished?: boolean;
}) {
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);

  useEffect(() => {
    if (!organizationId) return;
    let cancelled = false;
    setHandoff(null);
    callApi<Handoff>("/api/onboarding/start", {
      body: { organization_id: organizationId, mode: "card" },
    }).then((res) => {
      if (cancelled) return;
      if (res.data?.show_setup && res.data.code && res.data.wa_link) setHandoff(res.data);
    });
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  const loadSources = useCallback(async () => {
    if (!organizationId) return [] as KnowledgeSource[];
    const { data } = await knowledgeApi<{ sources: KnowledgeSource[] }>({
      organization_id: organizationId,
      action: "list",
    });
    const list = data?.sources ?? [];
    setSources(list);
    return list;
  }, [organizationId]);

  useEffect(() => {
    if (!organizationId) return;
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let wasReading = false;

    const tick = async () => {
      const list = await loadSources();
      if (stopped) return;
      const busy = list.some((s) => isReading(s.status));
      if (wasReading && !busy) {
        const done = list.find((s) => s.type === "website" && s.status === "ready");
        if (done) toast.success(`Aiden finished reading ${done.name}.`);
      }
      wasReading = busy;
      if (timer) clearInterval(timer);
      timer = setInterval(() => void tick(), busy ? 5000 : 60000);
    };

    void tick();
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
    };
  }, [organizationId, loadSources]);

  const readingNow = sources.find((s) => s.status === "syncing") ?? null;
  const finished =
    showFinished && !readingNow
      ? (sources.find(
          (s) =>
            s.type === "website" &&
            s.status === "ready" &&
            isFresh(s.last_synced_at) &&
            !dismissed.includes(s.id) &&
            typeof window !== "undefined" &&
            window.localStorage.getItem(DISMISS_KEY(s.id)) !== "1",
        ) ?? null)
      : null;

  // Reading wins over the setup card: one message at a time.
  if (readingNow) {
    return (
      <div className="mb-6 rounded-2xl border border-primary/20 bg-primary/5 p-5 sm:p-6 animate-in fade-in slide-in-from-bottom-2 duration-500">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <BookOpenCheck className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 className="text-lg font-bold tracking-tight text-foreground">
              Aiden is reading {readingNow.name} right now
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Usually 3–5 minutes. You can keep setting up.
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              <ReadingLine source={readingNow} />
            </p>
            <ReadingBar />
          </div>
        </div>
      </div>
    );
  }

  if (finished) {
    return (
      <div className="mb-6 flex items-start gap-3 rounded-2xl border border-primary/20 bg-primary/5 p-5 sm:p-6 animate-in fade-in slide-in-from-bottom-2 duration-500">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <BookOpenCheck className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold tracking-tight text-foreground">
            Aiden finished reading {finished.name} —{" "}
            {(finished.item_count ?? 0).toLocaleString("en-IN")} things.
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">Ask him something.</p>
        </div>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Dismiss"
          onClick={() => {
            window.localStorage.setItem(DISMISS_KEY(finished.id), "1");
            setDismissed((d) => [...d, finished.id]);
          }}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    );
  }

  if (!handoff) return null;

  return (
    <div className="mb-6 rounded-2xl border border-primary/20 bg-primary/5 p-5 sm:p-6 animate-in fade-in slide-in-from-bottom-2 duration-500">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <MessageCircle className="h-5 w-5" />
        </span>
        <div>
          <h2 className="text-lg font-bold tracking-tight text-foreground">
            Aiden isn't set up yet
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Message him with your code and he'll read your website.
          </p>
        </div>
      </div>
      <div className="mt-5">
        <AidenHandoff code={handoff.code} waLink={handoff.wa_link} compact />
      </div>
    </div>
  );
}
