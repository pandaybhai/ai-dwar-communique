import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, addEdge, applyEdgeChanges, applyNodeChanges,
  type Connection, type Edge, type EdgeChange, type Node, type NodeChange, useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { History, LayoutGrid, Play, Redo2, Save, Undo2, Upload, EyeOff, Settings2, Download, FileUp, Copy, Sparkles, Zap, Table2, Workflow } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DEFAULT_BUSINESS_HOURS, type BusinessHours } from "@/lib/flow-graph";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { callApi, uploadApi } from "@/lib/whatsapp-client";
import { unpinnedFlowNote } from "@/lib/flow-trigger-config";
import { maskHttpSecrets, validateGraph, type FlowGraph, type GraphProblem, type NodeType } from "@/lib/flow-graph";
import { FlowNodeCard, type RFData } from "./flow-node";
import { NODE_META, paletteTypes, uid } from "./node-meta";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { NodeConfig, type Pickers } from "./node-config";
import { SimulatorPanel } from "./simulator-panel";
import { TriggersPanel } from "./triggers-panel";
import { ResponsesPanel } from "./responses-panel";

type RFNode = Node<RFData>;
type Snapshot = { nodes: RFNode[]; edges: Edge[] };
export type VersionRow = { id: string; version: number; status: string; published_at: string | null; created_at: string };

const nodeTypes = { flow: FlowNodeCard };

function toRF(g: FlowGraph): Snapshot {
  return {
    nodes: g.nodes.map((n, i) => ({ id: n.id, type: "flow", position: n.position ?? { x: 80 + i * 40, y: 80 + i * 40 }, data: { kind: n.type, data: n.data } })),
    edges: g.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? "next", animated: false })),
  };
}
function fromRF(s: Snapshot): FlowGraph {
  return {
    nodes: s.nodes.map((n) => ({ id: n.id, type: n.data.kind, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) }, data: n.data.data })),
    edges: s.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? "next" })),
  };
}

/** Layered left-to-right layout from the start node. */
function autoLayout(s: Snapshot): RFNode[] {
  const start = s.nodes.find((n) => n.data.kind === "start");
  const layer = new Map<string, number>();
  const q: string[] = start ? [start.id] : [];
  if (start) layer.set(start.id, 0);
  while (q.length) {
    const id = q.shift()!;
    for (const e of s.edges.filter((x) => x.source === id)) {
      if (!layer.has(e.target)) {
        layer.set(e.target, layer.get(id)! + 1);
        q.push(e.target);
      }
    }
  }
  const rows = new Map<number, number>();
  const maxL = Math.max(0, ...layer.values());
  return s.nodes.map((n) => {
    const l = layer.get(n.id) ?? maxL + 1;
    const r = rows.get(l) ?? 0;
    rows.set(l, r + 1);
    return { ...n, position: { x: 60 + l * 320, y: 60 + r * 220 } };
  });
}

type Props = {
  organizationId: string;
  flowId: string;
  name: string;
  initial: FlowGraph;
  published: boolean;
  /** flows.is_enabled is false: a published flow then reads "Off". */
  switchedOff?: boolean;
  canEdit: boolean;
  pickers: Pickers;
  versions: VersionRow[];
  stats?: Record<string, { entered: number; exited: number; dropped: number }>;
  tags?: string[];
  onChanged: (remount?: boolean) => void;
  aiOn?: boolean;
  /** Responses tab: contacts.view to see it, contacts.export for the CSV (the server checks both again). */
  canViewResponses?: boolean;
  canExportResponses?: boolean;
  /** Open straight on the Responses view (the flows list's Responses link). */
  initialView?: "canvas" | "responses";
};

export function FlowEditor(props: Props) {
  return (
    <ReactFlowProvider>
      <EditorInner {...props} />
    </ReactFlowProvider>
  );
}

function EditorInner({ organizationId, flowId, name: initialName, initial, published, switchedOff, canEdit, pickers, versions, stats, tags, onChanged, aiOn, canViewResponses, canExportResponses, initialView }: Props) {
  const rf = useReactFlow();
  const navigate = useNavigate();
  const [meta, setMeta] = useState<NonNullable<FlowGraph["meta"]>>(() => initial.meta ?? {});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [triggersOpen, setTriggersOpen] = useState(false);
  const [view, setView] = useState<"canvas" | "responses">(initialView === "responses" && canViewResponses ? "responses" : "canvas");
  // Cards off: no Send card in the palette, and any Send card step is flagged.
  const { enabled: cardsOn, loading: cardsLoading } = useFeatureFlag("cards");
  const [genOpen, setGenOpen] = useState(false);
  const [genText, setGenText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [snap, setSnap] = useState<Snapshot>(() => toRF(initial));
  const [name, setName] = useState(initialName);
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [serverProblems, setServerProblems] = useState<GraphProblem[]>([]);
  const [simOpen, setSimOpen] = useState(false);
  const [histOpen, setHistOpen] = useState(false);
  const [path, setPath] = useState<string[]>([]);
  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const clipboard = useRef<Snapshot | null>(null);
  // shop: whether a WhatsApp shop (catalogue) is connected; unknown until the context loads.
  const [edCtx, setEdCtx] = useState<{ numbers: Array<{ id: string; label: string; onboarding: boolean }>; pinned: string | null; members: Array<{ id: string; name: string }>; shop?: boolean }>({ numbers: [], pinned: null, members: [] });
  useEffect(() => {
    void callApi<{ numbers: Array<{ id: string; label: string; onboarding: boolean }>; whatsapp_account_id: string | null; members: Array<{ id: string; name: string }>; whatsapp_shop_connected?: boolean }>("/api/flows/v2", {
      body: { action: "editor_context", organization_id: organizationId, flow_id: flowId },
    }).then(({ data }) => {
      if (data)
        setEdCtx({
          numbers: data.numbers ?? [],
          pinned: data.whatsapp_account_id ?? null,
          members: data.members ?? [],
          ...(typeof data.whatsapp_shop_connected === "boolean" ? { shop: data.whatsapp_shop_connected } : {}),
        });
    });
  }, [organizationId, flowId]);
  const setNumber = async (id: string | null) => {
    const { error } = await callApi("/api/flows/v2", { body: { action: "set_number", organization_id: organizationId, flow_id: flowId, whatsapp_account_id: id } });
    if (error) { toast.error(error); return; }
    setEdCtx((c) => ({ ...c, pinned: id }));
    toast.success(id ? "This flow now runs only on that number." : "This flow now runs on all your numbers.");
    const note = unpinnedFlowNote(edCtx.numbers, id);
    if (note) toast.warning(note);
  };
  const testHttp = useCallback(async (data: Record<string, unknown>) => {
    const { data: out, error } = await callApi<{ result: { ok: boolean; status: number | null; error: string | null; saved: Record<string, string>; preview: string } }>("/api/flows/v2", {
      body: { action: "test_http", organization_id: organizationId, data },
    });
    if (error || !out) return error ?? "Couldn't run the test.";
    const r = out.result;
    const saved = Object.entries(r.saved).map(([k, v]) => `{{${k}}} = ${v || "(empty)"}`).join("\n");
    return `${r.ok ? "Success" : "Failed"}${r.status ? ` · HTTP ${r.status}` : ""}${r.error ? ` · ${r.error}` : ""}${saved ? `\n\nSaved:\n${saved}` : ""}${r.preview ? `\n\nResponse:\n${r.preview}` : ""}`;
  }, [organizationId]);
  // Step pictures go to the same public image store as product pictures.
  const uploadImage = useCallback(async (file: File) => {
    const form = new FormData();
    form.append("organization_id", organizationId);
    form.append("purpose", "flow");
    form.append("file", file);
    const { data, error } = await uploadApi<{ url: string }>("/api/catalog/image", form);
    return { url: data?.url ?? null, error };
  }, [organizationId]);
  const onboardingNumber = edCtx.numbers.find((n) => n.onboarding) ?? null;

  const graph = useMemo(() => ({ ...fromRF(snap), meta }), [snap, meta]);
  const variables = useMemo(
    () => [...new Set(graph.nodes.map((n) => String(n.data["variable"] ?? "").trim()).filter(Boolean))],
    [graph],
  );
  const validateOpts = useMemo(
    () => ({ ...(edCtx.shop === undefined ? {} : { whatsappShop: edCtx.shop }), ...(cardsLoading ? {} : { cards: cardsOn }) }),
    [edCtx.shop, cardsOn, cardsLoading],
  );
  const problems = useMemo(() => [...validateGraph(graph, validateOpts), ...serverProblems], [graph, validateOpts, serverProblems]);
  const problemsByNode = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const p of problems) if (p.nodeId) m.set(p.nodeId, [...(m.get(p.nodeId) ?? []), p.message]);
    return m;
  }, [problems]);

  const commit = useCallback((next: Snapshot, record = true) => {
    setSnap((cur) => {
      if (record) {
        past.current = [...past.current.slice(-49), cur];
        future.current = [];
      }
      return next;
    });
    setDirty(true);
    setServerProblems([]);
  }, []);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    setSnap((cur) => { future.current.push(cur); return prev; });
    setDirty(true);
  }, []);
  const redo = useCallback(() => {
    const nxt = future.current.pop();
    if (!nxt) return;
    setSnap((cur) => { past.current.push(cur); return nxt; });
    setDirty(true);
  }, []);

  const onNodesChange = useCallback((changes: NodeChange<RFNode>[]) => {
    if (!canEdit) changes = changes.filter((c) => c.type === "select" || c.type === "dimensions");
    const structural = changes.some((c) => c.type === "remove" || (c.type === "position" && c.dragging === false));
    const safe = changes.filter((c) => !(c.type === "remove" && snap.nodes.find((n) => n.id === c.id)?.data.kind === "start"));
    setSnap((cur) => {
      if (structural) { past.current = [...past.current.slice(-49), cur]; future.current = []; }
      const nodes = applyNodeChanges(safe, cur.nodes);
      const ids = new Set(nodes.map((n) => n.id));
      return { nodes, edges: cur.edges.filter((e) => ids.has(e.source) && ids.has(e.target)) };
    });
    if (safe.some((c) => c.type !== "select" && c.type !== "dimensions")) setDirty(true);
  }, [canEdit, snap.nodes]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    if (!canEdit) return;
    setSnap((cur) => {
      if (changes.some((c) => c.type === "remove")) { past.current = [...past.current.slice(-49), cur]; future.current = []; setDirty(true); }
      return { ...cur, edges: applyEdgeChanges(changes, cur.edges) };
    });
  }, [canEdit]);

  const onConnect = useCallback((c: Connection) => {
    if (!canEdit) return;
    const handle = c.sourceHandle ?? "next";
    // One connection per output.
    const edges = snap.edges.filter((e) => !(e.source === c.source && (e.sourceHandle ?? "next") === handle));
    commit({ ...snap, edges: addEdge({ ...c, id: uid("e"), sourceHandle: handle }, edges) });
  }, [canEdit, snap, commit]);

  const addNode = (kind: NodeType) => {
    const center = rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const id = uid();
    commit({ ...snap, nodes: [...snap.nodes.map((n) => ({ ...n, selected: false })), { id, type: "flow", position: { x: center.x - 128, y: center.y - 60 }, selected: true, data: { kind, data: NODE_META[kind].defaults() } }] });
    setSelected(id);
  };

  const updateData = (id: string, data: Record<string, unknown>) => {
    const node = snap.nodes.find((n) => n.id === id);
    if (!node) return;
    // Removing an option removes its connection.
    const keep = new Set([...((data["buttons"] as Array<{ id: string }>) ?? []), ...((data["rows"] as Array<{ id: string }>) ?? []), ...((data["branches"] as Array<{ id: string }>) ?? [])].map((o) => o.id));
    const optionBased = ["buttons", "list", "branch"].includes(node.data.kind);
    const fixed = new Set(["next", "else", "window_closed", "invalid", "timeout"]);
    // "Hand to Aiden" ends the flow: the Assign step has no way out.
    const handsOff = node.data.kind === "assign" && data["mode"] === "aiden";
    commit({
      nodes: snap.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, data } } : n)),
      edges: handsOff ? snap.edges.filter((e) => e.source !== id) : optionBased ? snap.edges.filter((e) => e.source !== id || fixed.has(e.sourceHandle ?? "next") || keep.has(e.sourceHandle ?? "")) : snap.edges,
    });
  };

  const deleteNode = (id: string) => {
    commit({ nodes: snap.nodes.filter((n) => n.id !== id), edges: snap.edges.filter((e) => e.source !== id && e.target !== id) });
    setSelected(null);
  };

  // Keyboard: undo/redo/copy/paste.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]")) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || !canEdit || view !== "canvas") return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
      else if (k === "c") {
        const nodes = snap.nodes.filter((n) => n.selected && n.data.kind !== "start");
        const ids = new Set(nodes.map((n) => n.id));
        clipboard.current = { nodes, edges: snap.edges.filter((ed) => ids.has(ed.source) && ids.has(ed.target)) };
      } else if (k === "v" && clipboard.current?.nodes.length) {
        e.preventDefault();
        const map = new Map<string, string>();
        const nodes = clipboard.current.nodes.map((n) => { const id = uid(); map.set(n.id, id); return { ...n, id, selected: true, position: { x: n.position.x + 40, y: n.position.y + 40 }, data: structuredClone(n.data) }; });
        const edges = clipboard.current.edges.map((ed) => ({ ...ed, id: uid("e"), source: map.get(ed.source)!, target: map.get(ed.target)! }));
        commit({ nodes: [...snap.nodes.map((n) => ({ ...n, selected: false })), ...nodes], edges: [...snap.edges, ...edges] });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [snap, canEdit, undo, redo, commit, view]);

  const saveDraft = async (opts: { quiet?: boolean } = {}): Promise<boolean> => {
    setBusy(true);
    // A save that fails — refused, or never reached us (offline) — is said out
    // loud and the changes stay marked unsaved; it never fails silently.
    let saved: { graph?: FlowGraph } | null = null;
    let error: string | null = null;
    try {
      ({ data: saved, error } = await callApi<{ graph?: FlowGraph }>("/api/flows/v2", { body: { action: "save_draft", organization_id: organizationId, flow_id: flowId, graph, name } }));
    } catch {
      error = "Your changes weren't saved — check your connection and try again.";
    } finally {
      setBusy(false);
    }
    if (error) { setSaveError(error); toast.error(error); return false; }
    setSaveError(null);
    // Header values were moved to secure storage: keep only the references locally.
    const sealed = new Map((saved?.graph?.nodes ?? []).filter((n) => n.type === "http").map((n) => [n.id, n.data["headers"]]));
    if (sealed.size) setSnap((s) => ({ ...s, nodes: s.nodes.map((n) => (sealed.has(n.id) ? { ...n, data: { ...n.data, data: { ...n.data.data, headers: sealed.get(n.id) } } } : n)) }));
    setDirty(false);
    onChanged();
    if (!opts.quiet) {
      const note = unpinnedFlowNote(edCtx.numbers, edCtx.pinned);
      if (note) toast.warning(note);
    }
    return true;
  };

  const publish = async () => {
    const local = validateGraph(graph, validateOpts);
    if (local.length) { toast.error(`Fix ${local.length} problem${local.length === 1 ? "" : "s"} before publishing.`); return; }
    if (!(await saveDraft({ quiet: true }))) return;
    setBusy(true);
    let error: string | null = null;
    let raw: unknown = null;
    try {
      ({ error, raw } = await callApi<{ ok: boolean; version?: number }>("/api/flows/v2", { body: { action: "publish", organization_id: organizationId, flow_id: flowId } }));
    } catch {
      error = "We couldn't reach the server — the flow wasn't published. Try again.";
    } finally {
      setBusy(false);
    }
    const r = raw as { problems?: GraphProblem[] } | null;
    if (r?.problems?.length) { setServerProblems(r.problems); toast.error("Some steps need fixing before publishing."); return; }
    if (error) { toast.error(error); return; }
    toast.success("Published — new runs use this version.");
    const note = unpinnedFlowNote(edCtx.numbers, edCtx.pinned);
    if (note) toast.warning(note);
    onChanged();
  };

  const unpublish = async () => {
    setBusy(true);
    const { error } = await callApi("/api/flows/v2", { body: { action: "unpublish", organization_id: organizationId, flow_id: flowId } });
    setBusy(false);
    if (error) toast.error(error); else { toast.success("Unpublished. Running conversations finish on their version."); onChanged(); }
  };

  const restore = async (versionId: string) => {
    setBusy(true);
    const { error } = await callApi("/api/flows/v2", { body: { action: "restore", organization_id: organizationId, flow_id: flowId, version_id: versionId } });
    setBusy(false);
    if (error) toast.error(error); else { toast.success("Restored as draft."); setHistOpen(false); onChanged(true); }
  };

  const updateMeta = (patch: Partial<NonNullable<FlowGraph["meta"]>>) => { setMeta((m) => ({ ...m, ...patch })); setDirty(true); };

  const exportJson = () => {
    // Header values are secrets: exports carry header names only.
    const blob = new Blob([JSON.stringify({ name, graph: maskHttpSecrets(graph) }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "flow"}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importJson = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as { graph?: FlowGraph } & FlowGraph;
      const raw = parsed.graph ?? parsed;
      if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) throw new Error("bad");
      // Imports never bring header values or references to stored secrets.
      const g = maskHttpSecrets(raw);
      commit(toRF(g));
      setMeta(g.meta ?? {});
      toast.success("Imported into the draft — check it, then save.");
    } catch {
      toast.error("That file isn't a flow export.");
    }
  };
  const duplicate = async () => {
    setBusy(true);
    const { data, error } = await callApi<{ flow_id: string }>("/api/flows/v2", { body: { action: "create", organization_id: organizationId, name: `Copy of ${name}`.slice(0, 80), graph } });
    setBusy(false);
    if (error || !data) { toast.error(error ?? "Couldn't duplicate."); return; }
    toast.success("Duplicated as a draft.");
    void navigate({ to: "/app/flows/v2/$id", params: { id: data.flow_id } });
  };
  const generate = async () => {
    setBusy(true);
    const { data, error } = await callApi<{ graph: FlowGraph }>("/api/flows/v2", { body: { action: "generate", organization_id: organizationId, description: genText } });
    setBusy(false);
    if (error || !data) { toast.error(error ?? "Couldn't draft the flow."); return; }
    const s0 = toRF(data.graph);
    commit({ ...s0, nodes: autoLayout(s0) });
    setGenOpen(false);
    setTimeout(() => rf.fitView({ duration: 250 }), 50);
    toast.success("Draft ready — review each step, then save. Nothing is published.");
  };
  const bh: BusinessHours = meta.business_hours ?? DEFAULT_BUSINESS_HOURS;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const pathSet = useMemo(() => new Set(path), [path]);
  const rfNodes = useMemo(
    () => snap.nodes.map((n) => ({ ...n, data: { ...n.data, problems: problemsByNode.get(n.id), stats: stats?.[n.id] }, className: simOpen && pathSet.has(n.id) ? "rounded-2xl ring-2 ring-primary/60" : "" })),
    [snap.nodes, problemsByNode, stats, simOpen, pathSet],
  );
  const rfEdges = useMemo(() => snap.edges.map((e) => ({ ...e, animated: simOpen && pathSet.has(e.source) && pathSet.has(e.target) })), [snap.edges, simOpen, pathSet]);
  const sel = snap.nodes.find((n) => n.id === selected) ?? null;
  const onPath = useCallback((ids: string[]) => setPath(ids), []);
  const groups = ["Messages", "Ask", "Logic", "Actions", "Other"] as const;

  return (
    <div className="flex h-[calc(100vh-9rem)] min-h-[560px] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Input className="h-9 w-56 font-semibold" value={name} disabled={!canEdit} onChange={(e) => { setName(e.target.value); setDirty(true); }} />
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${published && !switchedOff ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>{published ? (switchedOff ? "Off" : "Published") : "Draft only"}</span>
        {dirty && (saveError ? <span className="text-xs font-medium text-destructive" role="alert" title={saveError}>Not saved — {saveError}</span> : <span className="text-xs text-muted-foreground">Unsaved changes</span>)}
        {canViewResponses && (
          <div role="tablist" aria-label="Flow view" className="inline-flex rounded-lg border border-border p-0.5">
            {([["canvas", "Canvas", Workflow], ["responses", "Responses", Table2]] as const).map(([v, label, Icon]) => (
              <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)}
                className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition ${view === v ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"}`}>
                <Icon className="h-3.5 w-3.5" /> {label}
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {canEdit && (<>
            <Button size="icon" variant="ghost" aria-label="Undo" onClick={undo}><Undo2 className="h-4 w-4" /></Button>
            <Button size="icon" variant="ghost" aria-label="Redo" onClick={redo}><Redo2 className="h-4 w-4" /></Button>
            <Button size="sm" variant="ghost" onClick={() => { commit({ ...snap, nodes: autoLayout(snap) }); setTimeout(() => rf.fitView({ duration: 250 }), 50); }}><LayoutGrid className="mr-1 h-4 w-4" /> Tidy</Button>
          </>)}
          <Button size="sm" variant="ghost" onClick={() => setHistOpen(true)}><History className="mr-1 h-4 w-4" /> Versions</Button>
          <Button size="sm" variant="ghost" onClick={() => setTriggersOpen(true)}><Zap className="mr-1 h-4 w-4" /> Triggers</Button>
          <Button size="sm" variant="ghost" onClick={() => setSettingsOpen(true)}><Settings2 className="mr-1 h-4 w-4" /> Flow settings</Button>
          <Button size="icon" variant="ghost" aria-label="Export" title="Export JSON" onClick={exportJson}><Download className="h-4 w-4" /></Button>
          {canEdit && (<>
            <Button size="icon" variant="ghost" aria-label="Import" title="Import JSON" onClick={() => fileRef.current?.click()}><FileUp className="h-4 w-4" /></Button>
            <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importJson(f); e.target.value = ""; }} />
            <Button size="icon" variant="ghost" aria-label="Duplicate" title="Duplicate flow" disabled={busy} onClick={() => void duplicate()}><Copy className="h-4 w-4" /></Button>
            {aiOn && <Button size="sm" variant="ghost" onClick={() => setGenOpen(true)}><Sparkles className="mr-1 h-4 w-4" /> Generate</Button>}
          </>)}
          <Button size="sm" variant="outline" onClick={() => setSimOpen(true)}><Play className="mr-1 h-4 w-4" /> Test</Button>
          {canEdit && (<>
            <Button size="sm" variant="outline" disabled={busy || !dirty} onClick={() => void saveDraft()}><Save className="mr-1 h-4 w-4" /> Save draft</Button>
            {published && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void unpublish()}><EyeOff className="mr-1 h-4 w-4" /> Unpublish</Button>}
            <Button size="sm" disabled={busy} onClick={() => void publish()}><Upload className="mr-1 h-4 w-4" /> Publish</Button>
          </>)}
        </div>
      </div>
      {view === "responses" && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ResponsesPanel organizationId={organizationId} flowId={flowId} canExport={Boolean(canExportResponses)} />
        </div>
      )}
      <div className={`flex min-h-0 flex-1${view === "responses" ? " hidden" : ""}`}>
        {canEdit && (
          <aside className="hidden w-48 shrink-0 overflow-y-auto border-r border-border p-3 md:block">
            {groups.map((g) => (
              <div key={g} className="mb-4">
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{g}</p>
                {paletteTypes({ cards: !cardsLoading && cardsOn }).filter((k) => NODE_META[k].group === g).map((k) => {
                  const M = NODE_META[k];
                  return (
                    <button key={k} type="button" title={M.hint} onClick={() => addNode(k)} className="mb-1 flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition hover:bg-muted">
                      <M.icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      <span className="min-w-0">
                        {M.label}
                        {M.hint && <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{M.hint}</span>}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </aside>
        )}
        <div className="relative min-w-0 flex-1">
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => setSelected(n.id)}
            onPaneClick={() => setSelected(null)}
            nodesDraggable={canEdit}
            nodesConnectable={canEdit}
            deleteKeyCode={canEdit ? ["Backspace", "Delete"] : null}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable className="!hidden sm:!block" />
          </ReactFlow>
          {problems.length > 0 && (
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-destructive/30 bg-background px-3 py-1 text-xs text-destructive shadow-sm">
              {problems.length} thing{problems.length === 1 ? "" : "s"} to fix before publishing{problems.find((p) => !p.nodeId) ? ` — ${problems.find((p) => !p.nodeId)!.message}` : ""}
            </div>
          )}
        </div>
        {sel && (
          <aside className="w-80 shrink-0 overflow-y-auto border-l border-border p-4">
            <fieldset disabled={!canEdit}>
              <NodeConfig
                node={{ id: sel.id, type: sel.data.kind, data: sel.data.data }}
                problems={problemsByNode.get(sel.id) ?? []}
                pickers={{ ...pickers, variables, members: edCtx.members, testHttp, uploadImage }}
                onChange={(d) => updateData(sel.id, d)}
                onDelete={() => deleteNode(sel.id)}
              />
            </fieldset>
          </aside>
        )}
      </div>

      <Sheet open={simOpen} onOpenChange={setSimOpen}>
        <SheetContent className="flex w-full flex-col sm:max-w-md">
          <SheetHeader><SheetTitle>Test this flow</SheetTitle></SheetHeader>
          <div className="min-h-0 flex-1 pt-2">{simOpen && <SimulatorPanel graph={graph} onPath={onPath} />}</div>
        </SheetContent>
      </Sheet>

      <Sheet open={triggersOpen} onOpenChange={setTriggersOpen}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          <SheetHeader><SheetTitle>Triggers</SheetTitle></SheetHeader>
          <TriggersPanel organizationId={organizationId} flowId={flowId} canEdit={canEdit} forms={pickers.forms} tags={tags ?? []} />
        </SheetContent>
      </Sheet>

      <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          <SheetHeader><SheetTitle>Flow settings</SheetTitle></SheetHeader>
          <fieldset disabled={!canEdit} className="mt-4 space-y-6">
            <section className="space-y-2">
              <h3 className="font-heading font-semibold">Which number</h3>
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                value={edCtx.pinned ?? ""}
                onChange={(e) => void setNumber(e.target.value || null)}
              >
                <option value="">All numbers</option>
                {edCtx.numbers.map((n) => <option key={n.id} value={n.id}>{n.label}{n.onboarding ? " (AiDwar setup number)" : ""}</option>)}
              </select>
              <p className="text-xs text-muted-foreground">Triggers only start this flow on the chosen number. Saved straight away.</p>
              {onboardingNumber && (
                <p className="rounded-md border border-border bg-muted/50 p-2 text-xs text-muted-foreground">
                  On the AiDwar setup number ({onboardingNumber.label}) a flow runs only when it's pinned to that number — “All numbers” doesn't include it.
                </p>
              )}
            </section>
            <section className="space-y-2">
              <h3 className="font-heading font-semibold">When the flow finishes</h3>
              <div className="space-y-1.5"><Label>Add tag</Label><Input value={meta.on_finish?.tag ?? ""} onChange={(e) => updateMeta({ on_finish: { ...meta.on_finish, tag: e.target.value } })} /></div>
              <div className="space-y-1.5"><Label>Mark Needs you with note</Label><Input value={meta.on_finish?.needs_you ?? ""} onChange={(e) => updateMeta({ on_finish: { ...meta.on_finish, needs_you: e.target.value } })} /></div>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(meta.on_finish?.close_chat)} onChange={(e) => updateMeta({ on_finish: { ...meta.on_finish, close_chat: e.target.checked } })} /> Close the chat</label>
            </section>
            <section className="space-y-2">
              <h3 className="font-heading font-semibold">Business hours</h3>
              <p className="text-xs text-muted-foreground">Used by the Business hours step and the "Business hours" branch condition. Workspace time zone.</p>
              {days.map((dn, i) => {
                const slot = bh.days[String(i)] ?? null;
                const setSlot = (v: [string, string] | null) => updateMeta({ business_hours: { ...bh, days: { ...bh.days, [String(i)]: v } } });
                return (
                  <div key={dn} className="flex items-center gap-2 text-sm">
                    <label className="flex w-16 items-center gap-1"><input type="checkbox" checked={!!slot} onChange={(e) => setSlot(e.target.checked ? ["09:00", "18:00"] : null)} /> {dn}</label>
                    {slot ? (<>
                      <Input type="time" className="h-8 w-28" value={slot[0]} onChange={(e) => setSlot([e.target.value, slot[1]])} />
                      <span>–</span>
                      <Input type="time" className="h-8 w-28" value={slot[1]} onChange={(e) => setSlot([slot[0], e.target.value])} />
                    </>) : <span className="text-muted-foreground">Closed</span>}
                  </div>
                );
              })}
              <div className="space-y-1.5"><Label>Holidays (yyyy-mm-dd, comma separated)</Label><Input value={bh.holidays.join(", ")} onChange={(e) => updateMeta({ business_hours: { ...bh, holidays: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) } })} /></div>
            </section>
          </fieldset>
        </SheetContent>
      </Sheet>

      <Dialog open={genOpen} onOpenChange={setGenOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Generate a flow from a description</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">I'll draft it from what I know about your business. It replaces the canvas as an unsaved draft — nothing is published.</p>
          <Textarea rows={5} placeholder="e.g. Greet customers, ask if they want to shop, track an order or talk to us; for tracking ask the order number and pass it to the team." value={genText} onChange={(e) => setGenText(e.target.value)} />
          <div className="flex justify-end"><Button disabled={busy || genText.trim().length < 10} onClick={() => void generate()}><Sparkles className="mr-1 h-4 w-4" /> {busy ? "Drafting…" : "Draft it"}</Button></div>
        </DialogContent>
      </Dialog>

      <Sheet open={histOpen} onOpenChange={setHistOpen}>
        <SheetContent className="w-full sm:max-w-md">
          <SheetHeader><SheetTitle>Version history</SheetTitle></SheetHeader>
          <ul className="mt-4 space-y-2">
            {versions.map((v) => (
              <li key={v.id} className="flex items-center justify-between rounded-xl border border-border p-3 text-sm">
                <div>
                  <p className="font-medium">Version {v.version} <span className="ml-1 text-xs capitalize text-muted-foreground">{v.status}</span></p>
                  <p className="text-xs text-muted-foreground">{new Date(v.published_at ?? v.created_at).toLocaleString("en-IN")}</p>
                </div>
                {canEdit && v.status !== "draft" && <Button size="sm" variant="outline" disabled={busy} onClick={() => void restore(v.id)}>Restore as draft</Button>}
              </li>
            ))}
          </ul>
        </SheetContent>
      </Sheet>
    </div>
  );
}
