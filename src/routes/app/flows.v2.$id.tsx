import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeft, Lock, Workflow } from "lucide-react";
import { aidwar } from "@/integrations/aidwar/client";
import { useOrg } from "@/lib/org-context";
import { usePermissions } from "@/hooks/use-permissions";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { usePublishedForms } from "@/hooks/use-published-forms";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { FlowEditor, type VersionRow } from "@/components/flows/v2/flow-editor";
import type { FlowGraph } from "@/lib/flow-graph";

export const Route = createFileRoute("/app/flows/v2/$id")({
  head: () => ({
    meta: [
      { title: "Flow editor — AiDwar" },
      { name: "description", content: "Design a chat flow with messages, questions, branches and actions, then test it before publishing." },
      { property: "og:title", content: "Flow editor — AiDwar" },
      { property: "og:description", content: "Visual chat flow builder with a built-in test chat." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: FlowEditorPage,
});

type Loaded = { name: string; graph: FlowGraph; published: boolean; versions: VersionRow[] };

function FlowEditorPage() {
  const { id } = Route.useParams();
  const { active } = useOrg();
  const { can, loading: permsLoading } = usePermissions();
  const { enabled, loading: flagLoading } = useFeatureFlag("flows_v2");
  const forms = usePublishedForms();
  const orgId = active?.organization.id ?? null;
  const [data, setData] = useState<Loaded | null>(null);
  const [templates, setTemplates] = useState<Array<{ id: string; name: string; status: string }>>([]);
  const [extra, setExtra] = useState<{ segments: string[]; flows: Array<{ id: string; name: string }>; products: Array<{ retailer_id: string; title: string }>; aiOn: boolean; tags: string[] }>({ segments: [], flows: [], products: [], aiOn: false, tags: [] });
  const [stats, setStats] = useState<Record<string, { entered: number; exited: number; dropped: number }>>({});
  const [error, setError] = useState<string | null>(null);
  const [rev, setRev] = useState(0);

  const load = useCallback(async () => {
    if (!orgId) return;
    const [{ data: flow, error: e1 }, { data: vers }, { data: tpl }] = await Promise.all([
      aidwar.from("flows").select("name, key").eq("id", id).eq("organization_id", orgId).maybeSingle(),
      aidwar.from("flow_versions").select("id, version, status, published_at, created_at, graph").eq("flow_id", id).order("version", { ascending: false }),
      aidwar.from("message_templates").select("id, name, status").eq("organization_id", orgId).order("name"),
    ]);
    if (e1 || !flow) { setError("We couldn't find this flow."); return; }
    const [{ data: segs }, { data: others }, { data: prods }, { data: agent }, { data: tagRows }] = await Promise.all([
      aidwar.from("segments").select("name").eq("organization_id", orgId).order("name"),
      aidwar.from("flows").select("id, name").eq("organization_id", orgId).like("key", "v2:%").neq("id", id).order("name"),
      aidwar.from("products").select("id, external_id, sku, title, source, meta_synced_at").eq("organization_id", orgId).or("source.eq.meta_catalog,meta_synced_at.not.is.null").order("title").limit(300),
      aidwar.from("ai_agents").select("mode").eq("organization_id", orgId).eq("is_default", true).maybeSingle(),
      aidwar.from("tags").select("name").eq("organization_id", orgId).order("name").limit(200),
    ]);
    setExtra({
      segments: ((segs ?? []) as Array<{ name: string }>).map((x) => x.name),
      flows: (others ?? []) as Array<{ id: string; name: string }>,
      products: ((prods ?? []) as Array<{ id: string; external_id: string | null; sku: string | null; title: string }>).map((x) => ({ retailer_id: x.external_id ?? x.sku ?? x.id, title: x.title })),
      aiOn: ["draft", "replying"].includes(String((agent as { mode?: string } | null)?.mode ?? "off")),
      tags: ((tagRows ?? []) as Array<{ name: string }>).map((x) => x.name),
    });
    // Per-node counts for the canvas (published version only).
    const { callApi } = await import("@/lib/whatsapp-client");
    const { data: statsData } = await callApi<{ stats: Record<string, { entered: number; exited: number; dropped: number }> }>("/api/flows/triggers", {
      body: { action: "node_stats", organization_id: orgId, flow_id: id },
    });
    setStats(statsData?.stats ?? {});
    const rows = (vers ?? []) as Array<VersionRow & { graph: FlowGraph }>;
    const draft = rows.find((r) => r.status === "draft");
    const pub = rows.find((r) => r.status === "published");
    const graph = (draft ?? pub ?? rows[0])?.graph ?? { nodes: [], edges: [] };
    setTemplates((tpl ?? []) as Array<{ id: string; name: string; status: string }>);
    setData({ name: (flow as { name: string }).name, graph, published: Boolean(pub), versions: rows.map(({ graph: _g, ...r }) => r) });
    setError(null);
  }, [id, orgId]);

  useEffect(() => { void load(); }, [load]);

  if (flagLoading || permsLoading || (!data && !error)) return <Skeleton className="h-[70vh] w-full rounded-2xl" />;
  if (!enabled) return <EmptyState icon={Lock} title="This isn't switched on for you yet" description="Chat flows aren't available on your account yet." />;
  if (error || !data || !orgId) return <ErrorState message={error ?? "We couldn't open this flow. Refresh to try again."} />;
  if (data.graph.meta?.legacy) return <EmptyState icon={Workflow} title="This is a store flow" description="Store flows are edited on the Automatic messages page." />;

  return (
    <div className="space-y-3">
      <Link to="/app/flows" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> All flows</Link>
      <FlowEditor
        key={`${id}:${rev}`}
        organizationId={orgId}
        flowId={id}
        name={data.name}
        initial={data.graph}
        published={data.published}
        canEdit={can("ai.configure")}
        pickers={{ templates, forms, variables: [], contactFields: ["email", "city", "pincode"], segments: extra.segments, flows: extra.flows, products: extra.products }}
        aiOn={extra.aiOn}
        versions={data.versions}
        stats={stats}
        tags={extra.tags}
        onChanged={(remount) => void load().then(() => remount && setRev((r) => r + 1))}
      />
    </div>
  );
}
