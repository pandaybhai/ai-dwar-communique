import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MAX_BRANCHES, MAX_BUTTONS, MAX_CONDITIONS, MAX_LIST_ROWS, type Branch, type Condition, type FlowNode } from "@/lib/flow-graph";
import { NODE_META, uid } from "./node-meta";

export type Pickers = {
  templates: Array<{ id: string; name: string; status: string }>;
  forms: Array<{ id: string; name: string }>;
  variables: string[];
  contactFields: string[];
  segments: string[];
  flows: Array<{ id: string; name: string }>;
  products: Array<{ retailer_id: string; title: string }>;
};

type Props = { node: FlowNode; problems: string[]; pickers: Pickers; onChange: (data: Record<string, unknown>) => void; onDelete: () => void };

const sel = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

export function NodeConfig({ node, problems, pickers, onChange, onDelete }: Props) {
  const d = node.data;
  const set = (k: string, v: unknown) => onChange({ ...d, [k]: v });
  const meta = NODE_META[node.type];

  const textField = (key = "text", label = "Message") => (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Textarea rows={4} value={String(d[key] ?? "")} onChange={(e) => set(key, e.target.value)} />
      <div className="flex flex-wrap gap-1">
        {["name", ...pickers.variables, ...pickers.contactFields.map((f) => `contact.${f}`)].map((v) => (
          <button key={v} type="button" onClick={() => set(key, `${String(d[key] ?? "")}{{${v}}}`)} className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground transition hover:border-primary hover:text-foreground">
            {`{{${v}}}`}
          </button>
        ))}
      </div>
    </div>
  );

  const options = (key: "buttons" | "rows", max: number, maxLen: number) => {
    const list = (d[key] as Array<{ id: string; title: string; description?: string }>) ?? [];
    return (
      <div className="space-y-2">
        <Label>{key === "buttons" ? `Buttons (max ${max})` : `Rows (max ${max})`}</Label>
        {list.map((o, i) => (
          <div key={o.id} className="flex gap-2">
            <Input maxLength={maxLen} value={o.title} onChange={(e) => set(key, list.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
            <Button variant="ghost" size="icon" aria-label="Remove" onClick={() => set(key, list.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
          </div>
        ))}
        {list.length < max && (
          <Button variant="outline" size="sm" onClick={() => set(key, [...list, { id: uid(key === "buttons" ? "b" : "r"), title: `Option ${list.length + 1}` }])}>
            <Plus className="mr-1 h-4 w-4" /> Add
          </Button>
        )}
      </div>
    );
  };

  const typing = (
    <div className="space-y-1.5">
      <Label>Typing delay before sending (seconds, max 5)</Label>
      <Input type="number" min={0} max={5} value={Number(d["typing_seconds"] ?? 0)} onChange={(e) => set("typing_seconds", Math.min(Math.max(Number(e.target.value), 0), 5))} />
    </div>
  );

  const saveTo = (
    <div className="space-y-1.5">
      <Label>Save answer to variable</Label>
      <Input placeholder="e.g. choice" value={String(d["variable"] ?? "")} onChange={(e) => set("variable", e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))} />
    </div>
  );

  const replyRules = (
    <>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5"><Label>Retries</Label><Input type="number" min={0} max={5} value={Number(d["retries"] ?? 2)} onChange={(e) => set("retries", Number(e.target.value))} /></div>
        <div className="space-y-1.5"><Label>No reply after (min)</Label><Input type="number" min={1} value={Number(d["timeout_minutes"] ?? 1440)} onChange={(e) => set("timeout_minutes", Number(e.target.value))} /></div>
      </div>
      <div className="space-y-1.5">
        <Label>If they type something unexpected</Label>
        <select className={sel} value={String(d["on_unexpected"] ?? "repeat")} onChange={(e) => set("on_unexpected", e.target.value)}>
          <option value="repeat">Repeat the question</option>
          <option value="options">Show the options again</option>
          <option value="path">Go to the "Unexpected" path</option>
          <option value="team">Hand to team</option>
        </select>
      </div>
      <div className="space-y-1.5"><Label>Retry message (optional)</Label><Input value={String(d["retry_text"] ?? "")} onChange={(e) => set("retry_text", e.target.value)} /></div>
      <div className="grid grid-cols-[6rem_1fr] gap-2">
        <div className="space-y-1.5"><Label>Nudge after (min)</Label><Input type="number" min={0} value={Number(d["nudge_minutes"] ?? 0)} onChange={(e) => set("nudge_minutes", Number(e.target.value))} /></div>
        <div className="space-y-1.5"><Label>Reminder if they go quiet</Label><Input placeholder="Still there? Just tap an option 🙂" value={String(d["nudge_text"] ?? "")} onChange={(e) => set("nudge_text", e.target.value)} /></div>
      </div>
      <p className="text-xs text-muted-foreground">One reminder is sent after the nudge time; if they still don't reply, the flow takes the "No reply" path.</p>
    </>
  );

  const branches = (d["branches"] as Branch[]) ?? [];
  const setBranches = (b: Branch[]) => set("branches", b);
  const subjects = [
    ...["last_answer", ...pickers.variables].map((v) => ({ v: `var:${v}`, l: `Variable: ${v}` })),
    ...["name", ...pickers.contactFields].map((f) => ({ v: `contact:${f}`, l: `Contact: ${f}` })),
    { v: "tag", l: "Tag" }, { v: "time_hour", l: "Hour of day (0–23)" }, { v: "weekday", l: "Weekday (0=Sun)" },
    { v: "business_hours", l: "Business hours (open/closed)" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 font-heading font-semibold"><meta.icon className="h-4 w-4 text-primary" /> {meta.label}</div>
        {node.type !== "start" && <Button variant="ghost" size="sm" onClick={onDelete}><Trash2 className="mr-1 h-4 w-4" /> Delete</Button>}
      </div>
      {problems.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {problems.map((p, i) => <li key={i}>{p}</li>)}
        </ul>
      )}
      <div className="space-y-1.5"><Label>Step name (optional)</Label><Input value={String(d["label"] ?? "")} onChange={(e) => set("label", e.target.value)} /></div>

      {node.type === "start" && <p className="text-sm text-muted-foreground">The flow begins here. Triggers (keywords, events) are set up on the flow's Triggers tab.</p>}
      {node.type === "text" && (<>{textField()}{typing}</>)}
      {node.type === "cta_url" && (
        <>
          {textField()}
          <div className="space-y-1.5"><Label>Button text</Label><Input maxLength={20} value={String(d["button_text"] ?? "")} onChange={(e) => set("button_text", e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Link</Label><Input placeholder="https://" value={String(d["url"] ?? "")} onChange={(e) => set("url", e.target.value)} /></div>
          {typing}
        </>
      )}
      {node.type === "location_request" && (<>{textField("text", "Message")}{saveTo}{replyRules}</>)}
      {node.type === "location_send" && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5"><Label>Latitude</Label><Input value={String(d["latitude"] ?? "")} onChange={(e) => set("latitude", e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Longitude</Label><Input value={String(d["longitude"] ?? "")} onChange={(e) => set("longitude", e.target.value)} /></div>
          <div className="col-span-2 space-y-1.5"><Label>Place name</Label><Input value={String(d["name"] ?? "")} onChange={(e) => set("name", e.target.value)} /></div>
          <div className="col-span-2 space-y-1.5"><Label>Address</Label><Input value={String(d["address"] ?? "")} onChange={(e) => set("address", e.target.value)} /></div>
        </div>
      )}
      {node.type === "contact_card" && (
        <div className="space-y-2">
          <div className="space-y-1.5"><Label>Name</Label><Input value={String(d["name"] ?? "")} onChange={(e) => set("name", e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Phone (with country code)</Label><Input placeholder="91XXXXXXXXXX" value={String(d["phone"] ?? "")} onChange={(e) => set("phone", e.target.value)} /></div>
        </div>
      )}
      {node.type === "carousel" && (
        <div className="space-y-2">
          <Label>Products from your WhatsApp catalogue (max 10)</Label>
          {pickers.products.length === 0 ? (
            <p className="text-sm text-muted-foreground">No catalogue products yet — sync your catalogue in Settings → WhatsApp first.</p>
          ) : (
            <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
              {pickers.products.map((p) => {
                const ids = (d["retailer_ids"] as string[]) ?? [];
                const on = ids.includes(p.retailer_id);
                return (
                  <label key={p.retailer_id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={on} disabled={!on && ids.length >= 10} onChange={() => {
                      const next = on ? ids.filter((x) => x !== p.retailer_id) : [...ids, p.retailer_id];
                      const titles = { ...((d["titles"] as Record<string, string>) ?? {}), [p.retailer_id]: p.title };
                      onChange({ ...d, retailer_ids: next, titles });
                    }} />
                    <span className="truncate">{p.title}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      )}
      {node.type === "set_variable" && (
        <>
          <div className="space-y-1.5"><Label>Variable</Label><Input value={String(d["variable"] ?? "")} onChange={(e) => set("variable", e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))} /></div>
          <div className="space-y-1.5">
            <Label>How</Label>
            <select className={sel} value={String(d["mode"] ?? "value")} onChange={(e) => set("mode", e.target.value)}>
              <option value="value">Text / join ({"{{a}} {{b}}"})</option>
              <option value="math">Calculate (+ − × ÷)</option>
              <option value="date">Date (today, now, today+7, {"{{date}}"}+2) → dd-mm-yyyy</option>
            </select>
          </div>
          {textField("expression", "Value")}
        </>
      )}
      {node.type === "business_hours" && <p className="text-sm text-muted-foreground">Goes to Open or Closed using the weekly schedule and holidays in Flow settings.</p>}
      {node.type === "ab_split" && <div className="space-y-1.5"><Label>Share going to A (%)</Label><Input type="number" min={0} max={100} value={Number(d["percent_a"] ?? 50)} onChange={(e) => set("percent_a", Number(e.target.value))} /></div>}
      {node.type === "goto_flow" && (
        <div className="space-y-1.5">
          <Label>Continue in flow</Label>
          <select className={sel} value={String(d["flow_id"] ?? "")} onChange={(e) => { const f = pickers.flows.find((x) => x.id === e.target.value); onChange({ ...d, flow_id: e.target.value, flow_name: f?.name ?? "" }); }}>
            <option value="">Pick a flow…</option>
            {pickers.flows.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
      )}
      {node.type === "internal_note" && textField("text", "Note (only your team sees it, in the run log)")}
      {node.type === "close_chat" && <p className="text-sm text-muted-foreground">Marks the chat closed and ends the flow.</p>}
      {node.type === "opt" && (
        <select className={sel} value={String(d["action"] ?? "in")} onChange={(e) => set("action", e.target.value)}>
          <option value="in">Opt the customer in</option>
          <option value="out">Opt the customer out (ends the flow)</option>
        </select>
      )}
      {node.type === "segment" && (
        <div className="space-y-2">
          <select className={sel} value={String(d["action"] ?? "add")} onChange={(e) => set("action", e.target.value)}><option value="add">Add to</option><option value="remove">Remove from</option></select>
          <Input list="flow-segments" placeholder="Segment name" value={String(d["segment_name"] ?? "")} onChange={(e) => set("segment_name", e.target.value)} />
          <datalist id="flow-segments">{pickers.segments.map((x) => <option key={x} value={x} />)}</datalist>
          <p className="text-xs text-muted-foreground">Adds the tag "Segment: {String(d["segment_name"] || "name")}". Filter a segment on that tag to include these contacts.</p>
        </div>
      )}
      {node.type === "sheets_append" && (
        <div className="space-y-2">
          <Label>Google Sheet link</Label>
          <Input placeholder="https://docs.google.com/spreadsheets/d/…" value={String(d["sheet"] ?? "")} onChange={(e) => set("sheet", e.target.value)} />
          <Label>Tab name</Label>
          <Input value={String(d["tab"] ?? "Sheet1")} onChange={(e) => set("tab", e.target.value)} />
          <Label>Columns (one value per column, {"{{variables}}"} allowed)</Label>
          {((d["columns"] as string[]) ?? []).map((c, i, arr) => (
            <div key={i} className="flex gap-2">
              <Input value={c} onChange={(e) => set("columns", arr.map((x, j) => (j === i ? e.target.value : x)))} />
              <Button variant="ghost" size="icon" aria-label="Remove column" onClick={() => set("columns", arr.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
            </div>
          ))}
          {((d["columns"] as string[]) ?? []).length < 26 && <Button variant="outline" size="sm" onClick={() => set("columns", [...((d["columns"] as string[]) ?? []), ""])}><Plus className="mr-1 h-4 w-4" /> Add column</Button>}
          <p className="text-xs text-muted-foreground">Uses the Google account connected in Settings → Integrations. That account must be able to edit the sheet.</p>
        </div>
      )}
      {node.type === "payment" && (
        <div className="space-y-2">
          <Label>Amount (₹)</Label>
          <Input placeholder="499 or {{total}}" value={String(d["amount"] ?? "")} onChange={(e) => set("amount", e.target.value)} />
          <Label>What it's for</Label>
          <Input value={String(d["description"] ?? "")} onChange={(e) => set("description", e.target.value)} />
          {textField("text", "Message sent with the link")}
          <Label>Wait for payment (hours)</Label>
          <Input type="number" min={1} max={312} value={Number(d["wait_hours"] ?? 24)} onChange={(e) => set("wait_hours", Number(e.target.value))} />
          <p className="text-xs text-muted-foreground">Creates a payment link on your own Razorpay account (Settings → Integrations). Paid goes to "Paid"; otherwise "Not paid" after the wait. {"{{payment_link}}"} and {"{{payment_status}}"} are available afterwards.</p>
        </div>
      )}
      {node.type === "note" && textField("text", "Note (never sent)")}
      {node.type === "buttons" && (<>{textField()}{options("buttons", MAX_BUTTONS, 20)}{saveTo}{typing}{replyRules}</>)}
      {node.type === "list" && (<>{textField()}<div className="space-y-1.5"><Label>List button text</Label><Input maxLength={20} value={String(d["button_text"] ?? "Choose")} onChange={(e) => set("button_text", e.target.value)} /></div>{options("rows", MAX_LIST_ROWS, 24)}{saveTo}{replyRules}</>)}
      {node.type === "ask" && (
        <>
          {textField("text", "Question")}
          {saveTo}
          <div className="space-y-1.5">
            <Label>Answer must be</Label>
            <select className={sel} value={String(d["validation"] ?? "text")} onChange={(e) => set("validation", e.target.value)}>
              {["text", "number", "email", "phone", "pincode", "date"].map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
          {replyRules}
        </>
      )}
      {node.type === "template" && (
        <div className="space-y-1.5">
          <Label>Approved template</Label>
          <select className={sel} value={String(d["template_id"] ?? "")} onChange={(e) => { const t = pickers.templates.find((x) => x.id === e.target.value); onChange({ ...d, template_id: e.target.value, template_name: t?.name ?? "" }); }}>
            <option value="">Pick a template…</option>
            {pickers.templates.map((t) => <option key={t.id} value={t.id}>{t.name}{t.status.toUpperCase() !== "APPROVED" ? ` (${t.status.toLowerCase()})` : ""}</option>)}
          </select>
          <p className="text-xs text-muted-foreground">Templates are the only messages that send when the 24-hour window is closed.</p>
        </div>
      )}
      {node.type === "form" && (
        <div className="space-y-1.5">
          <Label>Published form</Label>
          <select className={sel} value={String(d["form_id"] ?? "")} onChange={(e) => { const f = pickers.forms.find((x) => x.id === e.target.value); onChange({ ...d, form_id: e.target.value, form_name: f?.name ?? "" }); }}>
            <option value="">Pick a form…</option>
            {pickers.forms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
      )}
      {node.type === "wait" && <div className="space-y-1.5"><Label>Wait (minutes)</Label><Input type="number" min={1} value={Number(d["minutes"] ?? 60)} onChange={(e) => set("minutes", Number(e.target.value))} /></div>}
      {node.type === "tag" && (
        <div className="grid grid-cols-3 gap-2">
          <select className={sel} value={String(d["action"] ?? "add")} onChange={(e) => set("action", e.target.value)}><option value="add">Add</option><option value="remove">Remove</option></select>
          <Input className="col-span-2" placeholder="Tag name" value={String(d["tag"] ?? "")} onChange={(e) => set("tag", e.target.value)} />
        </div>
      )}
      {node.type === "set_field" && (
        <>
          <div className="space-y-1.5"><Label>Contact field</Label><Input list="flow-contact-fields" value={String(d["field"] ?? "")} onChange={(e) => set("field", e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))} /><datalist id="flow-contact-fields">{["name", ...pickers.contactFields].map((f) => <option key={f} value={f} />)}</datalist></div>
          {textField("value", "Value")}
        </>
      )}
      {node.type === "needs_you" && textField("note", "Note for your team")}
      {node.type === "assign" && (
        <div className="space-y-1.5">
          <Label>Assign</Label>
          <select className={sel} value={String(d["mode"] ?? "queue")} onChange={(e) => set("mode", e.target.value)}>
            <option value="queue">To the team queue (Needs you)</option>
            <option value="round_robin">Round-robin — teammate with the fewest open chats</option>
          </select>
        </div>
      )}
      {node.type === "branch" && (
        <div className="space-y-3">
          {branches.map((b, bi) => (
            <div key={b.id} className="space-y-2 rounded-xl border border-border p-3">
              <div className="flex gap-2">
                <Input value={b.label ?? ""} onChange={(e) => setBranches(branches.map((x, j) => (j === bi ? { ...x, label: e.target.value } : x)))} />
                <select className={`${sel} w-24`} value={b.match} onChange={(e) => setBranches(branches.map((x, j) => (j === bi ? { ...x, match: e.target.value as "all" | "any" } : x)))}><option value="all">AND</option><option value="any">OR</option></select>
                <Button variant="ghost" size="icon" aria-label="Remove branch" onClick={() => setBranches(branches.filter((_, j) => j !== bi))}><Trash2 className="h-4 w-4" /></Button>
              </div>
              {b.conditions.map((c, ci) => {
                const upd = (patch: Partial<Condition>) => setBranches(branches.map((x, j) => (j === bi ? { ...x, conditions: x.conditions.map((y, k) => (k === ci ? { ...y, ...patch } : y)) } : x)));
                return (
                  <div key={ci} className="grid grid-cols-[1fr_auto_1fr_auto] gap-1">
                    <select className={sel} value={c.subject} onChange={(e) => upd({ subject: e.target.value })}>{subjects.map((s) => <option key={s.v} value={s.v}>{s.l}</option>)}</select>
                    <select className={`${sel} w-28`} value={c.op} onChange={(e) => upd({ op: e.target.value as Condition["op"] })}>
                      {[["eq", "is"], ["neq", "is not"], ["contains", "contains"], ["matches", "matches pattern"], ["not_contains", "doesn't contain"], ["gt", ">"], ["lt", "<"], ["exists", "is set"], ["not_exists", "is empty"], ["has", "has tag"], ["not_has", "lacks tag"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    <Input value={c.value ?? ""} onChange={(e) => upd({ value: e.target.value })} />
                    <Button variant="ghost" size="icon" aria-label="Remove condition" onClick={() => setBranches(branches.map((x, j) => (j === bi ? { ...x, conditions: x.conditions.filter((_, k) => k !== ci) } : x)))}><Trash2 className="h-4 w-4" /></Button>
                  </div>
                );
              })}
              {b.conditions.length < MAX_CONDITIONS && <Button variant="outline" size="sm" onClick={() => setBranches(branches.map((x, j) => (j === bi ? { ...x, conditions: [...x.conditions, { subject: "var:last_answer", op: "eq", value: "" }] } : x)))}><Plus className="mr-1 h-4 w-4" /> Condition</Button>}
            </div>
          ))}
          {branches.length < MAX_BRANCHES && <Button variant="outline" size="sm" onClick={() => setBranches([...branches, { id: uid("br"), label: `Branch ${branches.length + 1}`, match: "all", conditions: [{ subject: "var:last_answer", op: "eq", value: "" }] }])}><Plus className="mr-1 h-4 w-4" /> Branch</Button>}
          <p className="text-xs text-muted-foreground">Anything that matches no branch goes to Else.</p>
        </div>
      )}
    </div>
  );
}
