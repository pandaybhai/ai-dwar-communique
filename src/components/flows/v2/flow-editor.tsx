import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background, BackgroundVariant, ConnectionLineType, MiniMap, Panel, ReactFlow, ReactFlowProvider, addEdge, applyEdgeChanges, applyNodeChanges, useViewport,
  type Connection, type Edge, type EdgeChange, type Node, type NodeChange, useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { AlertCircle, History, LayoutGrid, Maximize, Minus, MoreHorizontal, Play, Plus, Redo2, Save, Search, Undo2, Upload, EyeOff, Settings2, Download, FileUp, Copy, Sparkles, Zap, Table2, Workflow, Trash2, X } from "lucide-react";
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
import { DeleteFlowDialog } from "@/components/flows/v2/delete-flow-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MOD_KEY } from "@/lib/keyboard";
import { styleOf } from "./node-style";

type RFNode = Node<RFData>;
type Snapshot = { nodes: RFNode[]; edges: Edge[] };
export type VersionRow = { id: string; version: number; status: string; published_at: string | null; created_at: string };

const nodeTypes = { flow: FlowNodeCard };
/** Batch 42: what a palette step carries while it is dragged onto the canvas. */
const DRAG_TYPE = "application/x-aidwar-step";

/** Follows the app's light / dark switch (the .dark class on <html>), for the canvas's own colours. */
function useDarkTheme(): boolean {
  const [dark, setDark] = useState(() => typeof document !== "undefined" && document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const root = document.documentElement;
    const obs = new MutationObserver(() => setDark(root.classList.contains("dark")));
    obs.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

/** Batch 42: zoom out, the zoom level, zoom in and fit — one bar in the canvas corner. */
function ZoomBar() {
  const rf = useReactFlow();
  const { zoom } = useViewport();
  const btn = "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <Panel position="bottom-left" className="!m-3 flex items-center gap-0.5 rounded-lg border border-border bg-card p-0.5 shadow-sm">
      <button type="button" aria-label="Zoom out" className={btn} onClick={() => void rf.zoomOut({ duration: 150 })}><Minus className="h-3.5 w-3.5" /></button>
      <button type="button" aria-label="Reset zoom to 100%" title="Reset to 100%" className="tabular h-7 min-w-11 rounded-md px-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => void rf.zoomTo(1, { duration: 150 })}>
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" aria-label="Zoom in" className={btn} onClick={() => void rf.zoomIn({ duration: 150 })}><Plus className="h-3.5 w-3.5" /></button>
      <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" />
      <button type="button" aria-label="Fit the whole flow" title="Fit the whole flow" className={btn} onClick={() => void rf.fitView({ duration: 250, padding: 0.2 })}><Maximize className="h-3.5 w-3.5" /></button>
    </Panel>
  );
}

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
  const [paletteSearch, setPaletteSearch] = useState("");
  const dark = useDarkTheme();
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

  const addNode = (kind: NodeType, at?: { x: number; y: number }) => {
    const center = at ?? rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const id = uid();
    // Batch 42: a new step lands on the 16px grid, like a dragged one.
    const snapTo = (v: number) => Math.round(v / 16) * 16;
    commit({ ...snap, nodes: [...snap.nodes.map((n) => ({ ...n, selected: false })), { id, type: "flow", position: { x: snapTo(center.x - 128), y: snapTo(center.y - (at ? 24 : 60)) }, selected: true, data: { kind, data: NODE_META[kind].defaults() } }] });
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

  // Batch 42: Ctrl/⌘ S saves the draft (also while typing in a step); Esc closes the step panel.
  const saveRef = useRef<() => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (view !== "canvas") return;
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        if (!canEdit) return;
        e.preventDefault();
        saveRef.current();
      } else if (e.key === "Escape" && !(e.target as HTMLElement | null)?.closest?.('[role="dialog"], [role="menu"]')) {
        setSelected(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canEdit, view]);

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

  saveRef.current = () => {
    if (dirty && !busy) void saveDraft();
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

  // Batch 35: "Delete flow" — confirm (with the running-conversation count), then back to the list.
  const [deleteOpen, setDeleteOpen] = useState(false);

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
    () => snap.nodes.map((n) => ({ ...n, data: { ...n.data, problems: problemsByNode.get(n.id), stats: stats?.[n.id] }, className: simOpen && pathSet.has(n.id) ? "rounded-xl ring-2 ring-primary/60" : "" })),
    [snap.nodes, problemsByNode, stats, simOpen, pathSet],
  );
  // Batch 42: rounded right-angle connections; the test chat's path is drawn in the accent.
  const rfEdges = useMemo(() => snap.edges.map((e) => {
    const onPath = simOpen && pathSet.has(e.source) && pathSet.has(e.target);
    return { ...e, type: "smoothstep", pathOptions: { borderRadius: 14 }, animated: onPath, style: { strokeWidth: onPath ? 2.25 : 1.5, stroke: onPath ? "var(--primary)" : "var(--border-strong)" } };
  }), [snap.edges, simOpen, pathSet]);
  const nodeName = (nodeId: string) => {
    const n = snap.nodes.find((x) => x.id === nodeId);
    return n ? String(n.data.data["label"] ?? "") || NODE_META[n.data.kind].label : "A step";
  };
  const sel = snap.nodes.find((n) => n.id === selected) ?? null;
  const onPath = useCallback((ids: string[]) => setPath(ids), []);
  const groups = ["Messages", "Ask", "Logic", "Actions", "Other"] as const;

  const problemNodes = problems.filter((p) => p.nodeId);
  const focusNode = (nodeId: string) => {
    setSelected(nodeId);
    setSnap((cur) => ({ ...cur, nodes: cur.nodes.map((n) => ({ ...n, selected: n.id === nodeId })) }));
    setTimeout(() => void rf.fitView({ nodes: [{ id: nodeId }], duration: 300, maxZoom: 1.1, padding: 0.6 }), 30);
  };
  const paletteQuery = paletteSearch.trim().toLowerCase();
  const palette = paletteTypes({ cards: !cardsLoading && cardsOn }).filter(
    (k) => !paletteQuery || `${NODE_META[k].label} ${NODE_META[k].hint ?? ""}`.toLowerCase().includes(paletteQuery),
  );
  const selStyle = sel ? styleOf(sel.data.kind) : null;
  const tip = (label: string, hint?: string) => (
    <TooltipContent side="bottom" className="flex items-center gap-2">
      {label}
      {hint ? <Kbd>{hint}</Kbd> : null}
    </TooltipContent>
  );

  return (
    <div className="flex h-[calc(100dvh-9rem)] min-h-[560px] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xs">
      <div className="flex items-center gap-2 overflow-x-auto border-b border-border px-3 py-2 [scrollbar-width:none]">
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          <label htmlFor="flow-name" className="sr-only">Flow name</label>
          <Input id="flow-name" className="h-8 w-44 border-transparent bg-transparent px-2 font-semibold shadow-none hover:border-border focus-visible:border-ring sm:w-60" value={name} disabled={!canEdit} onChange={(e) => { setName(e.target.value); setDirty(true); }} />
          <span className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${published && !switchedOff ? "border-success-border bg-success-soft text-success-soft-foreground" : "border-border bg-muted text-muted-foreground"}`}>{published ? (switchedOff ? "Off" : "Published") : "Draft only"}</span>
          {dirty && (saveError ? <span className="max-w-56 shrink-0 truncate text-xs font-medium text-danger" role="alert" title={saveError}>Not saved — {saveError}</span> : <span className="shrink-0 text-xs text-muted-foreground">Unsaved changes</span>)}
        </div>
        {canViewResponses && (
          <div role="tablist" aria-label="Flow view" className="inline-flex shrink-0 rounded-lg bg-muted p-0.5">
            {([["canvas", "Canvas", Workflow], ["responses", "Responses", Table2]] as const).map(([v, label, Icon]) => (
              <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)}
                className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors duration-150 ${view === v ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"}`}>
                <Icon className="h-3.5 w-3.5" /> {label}
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {canEdit && view === "canvas" && (<>
            <Tooltip><TooltipTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="Undo" onClick={undo}><Undo2 className="h-4 w-4" /></Button></TooltipTrigger>{tip("Undo", `${MOD_KEY} Z`)}</Tooltip>
            <Tooltip><TooltipTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="Redo" onClick={redo}><Redo2 className="h-4 w-4" /></Button></TooltipTrigger>{tip("Redo", `${MOD_KEY} ⇧ Z`)}</Tooltip>
            <Tooltip><TooltipTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="Tidy" onClick={() => { commit({ ...snap, nodes: autoLayout(snap) }); setTimeout(() => rf.fitView({ duration: 250 }), 50); }}><LayoutGrid className="h-4 w-4" /></Button></TooltipTrigger>{tip("Tidy the canvas")}</Tooltip>
            <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
          </>)}
          <Button size="sm" variant="ghost" onClick={() => setTriggersOpen(true)}><Zap className="h-4 w-4" /> <span className="hidden lg:inline">Triggers</span><span className="sr-only lg:hidden">Triggers</span></Button>
          <Button size="sm" variant="ghost" onClick={() => setHistOpen(true)}><History className="h-4 w-4" /> <span className="hidden lg:inline">Versions</span><span className="sr-only lg:hidden">Versions</span></Button>
          <Button size="sm" variant="ghost" onClick={() => setSettingsOpen(true)}><Settings2 className="h-4 w-4" /> <span className="hidden xl:inline">Flow settings</span><span className="sr-only xl:hidden">Flow settings</span></Button>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-sm" variant="ghost" aria-label="More actions"><MoreHorizontal className="h-4 w-4" /></Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              {tip("More actions")}
            </Tooltip>
            <DropdownMenuContent align="end" className="w-52">
              {canEdit && aiOn ? <DropdownMenuItem onSelect={() => setGenOpen(true)}><Sparkles className="h-4 w-4" /> Generate</DropdownMenuItem> : null}
              <DropdownMenuItem onSelect={exportJson}><Download className="h-4 w-4" /> Export JSON</DropdownMenuItem>
              {canEdit ? (<>
                <DropdownMenuItem onSelect={() => fileRef.current?.click()}><FileUp className="h-4 w-4" /> Import JSON</DropdownMenuItem>
                <DropdownMenuItem disabled={busy} onSelect={() => void duplicate()}><Copy className="h-4 w-4" /> Duplicate flow</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={busy} onSelect={() => setDeleteOpen(true)} className="text-danger focus:text-danger"><Trash2 className="h-4 w-4" /> Delete flow</DropdownMenuItem>
              </>) : null}
            </DropdownMenuContent>
          </DropdownMenu>
          {canEdit && <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importJson(f); e.target.value = ""; }} />}
          <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
          <Button size="sm" variant="outline" onClick={() => setSimOpen(true)}><Play className="h-4 w-4" /> Test</Button>
          {canEdit && (<>
            <Tooltip><TooltipTrigger asChild><Button size="sm" variant="outline" disabled={busy || !dirty} onClick={() => void saveDraft()}><Save className="h-4 w-4" /> Save draft</Button></TooltipTrigger>{tip("Save draft", `${MOD_KEY} S`)}</Tooltip>
            {published && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void unpublish()}><EyeOff className="h-4 w-4" /> Unpublish</Button>}
            <Button size="sm" disabled={busy} onClick={() => void publish()}><Upload className="h-4 w-4" /> Publish</Button>
          </>)}
        </div>
      </div>
      <DeleteFlowDialog
        organizationId={organizationId}
        flow={{ id: flowId, name }}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={() => void navigate({ to: "/app/flows", search: { tab: "chat" } })}
      />
      {view === "responses" && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ResponsesPanel organizationId={organizationId} flowId={flowId} canExport={Boolean(canExportResponses)} />
        </div>
      )}
      <div className={`relative flex min-h-0 flex-1${view === "responses" ? " hidden" : ""}`}>
        {canEdit && (
          <aside aria-label="Steps you can add" className="hidden w-56 shrink-0 flex-col border-r border-border bg-subtle md:flex">
            <div className="border-b border-border p-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" aria-hidden="true" />
                <Input value={paletteSearch} onChange={(e) => setPaletteSearch(e.target.value)} placeholder="Find a step" aria-label="Find a step" className="h-8 bg-card pl-8 text-sm" />
              </div>
              <p className="mt-1.5 px-0.5 text-[0.6875rem] text-muted-foreground">Click to add, or drag onto the canvas.</p>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {groups.map((g) => {
                const items = palette.filter((k) => NODE_META[k].group === g);
                if (!items.length) return null;
                return (
                  <div key={g} className="mb-3">
                    <p className="mb-1 px-2 text-xs font-medium text-muted-foreground">{g}</p>
                    {items.map((k) => {
                      const M = NODE_META[k];
                      const st = styleOf(k);
                      return (
                        <button
                          key={k}
                          type="button"
                          title={M.hint}
                          draggable
                          onDragStart={(e) => { e.dataTransfer.setData(DRAG_TYPE, k); e.dataTransfer.effectAllowed = "copy"; }}
                          onClick={() => addNode(k)}
                          className="mb-0.5 flex w-full cursor-grab items-start gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors duration-150 hover:bg-card hover:shadow-xs active:cursor-grabbing"
                        >
                          <span className={`mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded ${st.chip}`}><M.icon className="h-3 w-3" aria-hidden="true" /></span>
                          <span className="min-w-0">
                            {M.label}
                            {M.hint && <span className="mt-0.5 block text-[0.6875rem] leading-snug text-muted-foreground">{M.hint}</span>}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
              {palette.length === 0 ? <p className="px-2 py-6 text-center text-xs text-muted-foreground">No step matches “{paletteSearch}”.</p> : null}
            </div>
          </aside>
        )}
        <div className="relative min-w-0 flex-1" onDragOver={(e) => { if (canEdit && e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }} onDrop={(e) => {
          const kind = e.dataTransfer.getData(DRAG_TYPE) as NodeType;
          if (!canEdit || !kind || !NODE_META[kind]) return;
          e.preventDefault();
          addNode(kind, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
        }}>
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
            snapToGrid
            snapGrid={[16, 16]}
            connectionLineType={ConnectionLineType.SmoothStep}
            connectionLineStyle={{ stroke: "var(--primary)", strokeWidth: 2 }}
            colorMode={dark ? "dark" : "light"}
            minZoom={0.2}
            maxZoom={2}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
            proOptions={{ hideAttribution: true }}
            className="bg-subtle"
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1.2} color="var(--border-strong)" />
            <ZoomBar />
            <MiniMap
              pannable
              zoomable
              ariaLabel="Map of the whole flow"
              className="!m-3 !hidden overflow-hidden !rounded-lg !border !border-border !bg-card !shadow-sm sm:!block"
              nodeColor={(n) => styleOf((n.data as RFData).kind).fill}
              nodeBorderRadius={8}
              maskColor="color-mix(in oklch, var(--background) 70%, transparent)"
            />
          </ReactFlow>
          {problems.length > 0 && (
            <div className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2">
              <Popover>
                <PopoverTrigger asChild>
                  <button type="button" className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-danger-border bg-card px-3 py-1.5 text-xs font-medium text-danger-soft-foreground shadow-md transition-colors duration-150 hover:bg-danger-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
                    {problems.length} thing{problems.length === 1 ? "" : "s"} to fix before publishing{problems.find((p) => !p.nodeId) ? ` — ${problems.find((p) => !p.nodeId)!.message}` : ""}
                  </button>
                </PopoverTrigger>
                <PopoverContent side="top" align="center" className="w-80 p-1.5">
                  <ul className="max-h-64 overflow-y-auto">
                    {problems.map((p, i) => (
                      <li key={i}>
                        {p.nodeId ? (
                          <button type="button" onClick={() => focusNode(p.nodeId!)} className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent">
                            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" aria-hidden="true" />
                            <span className="min-w-0">
                              <span className="block font-medium text-foreground">{nodeName(p.nodeId)}</span>
                              <span className="block text-xs text-muted-foreground">{p.message}</span>
                            </span>
                          </button>
                        ) : (
                          <p className="flex items-start gap-2 px-2 py-1.5 text-sm text-foreground"><AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" aria-hidden="true" />{p.message}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                  {problemNodes.length > 0 ? <p className="border-t border-border px-2 pb-1 pt-2 text-xs text-muted-foreground">Pick one to jump to that step.</p> : null}
                </PopoverContent>
              </Popover>
            </div>
          )}
        </div>
        {sel && (
          <aside aria-label="Edit step" className="absolute inset-x-0 bottom-0 z-20 flex max-h-[65%] flex-col border-t border-border bg-card shadow-2xl md:static md:z-auto md:max-h-none md:w-96 md:shrink-0 md:border-l md:border-t-0 md:shadow-none">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
              <span className={`flex h-6 w-6 items-center justify-center rounded-md ${selStyle?.chip ?? ""}`}>{(() => { const I = NODE_META[sel.data.kind].icon; return <I className="h-3.5 w-3.5" aria-hidden="true" />; })()}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{String(sel.data.data["label"] ?? "") || NODE_META[sel.data.kind].label}</span>
                {selStyle?.label ? <span className="block text-xs text-muted-foreground">{selStyle.label}</span> : null}
              </span>
              <Tooltip><TooltipTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="Close" onClick={() => setSelected(null)}><X className="h-4 w-4" /></Button></TooltipTrigger>{tip("Close", "Esc")}</Tooltip>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <fieldset disabled={!canEdit}>
                <NodeConfig
                  node={{ id: sel.id, type: sel.data.kind, data: sel.data.data }}
                  problems={problemsByNode.get(sel.id) ?? []}
                  pickers={{ ...pickers, variables, members: edCtx.members, testHttp, uploadImage }}
                  onChange={(d) => updateData(sel.id, d)}
                  onDelete={() => deleteNode(sel.id)}
                />
              </fieldset>
            </div>
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
