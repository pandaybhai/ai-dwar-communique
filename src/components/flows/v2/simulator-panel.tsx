import { useEffect, useRef, useState } from "react";
import { RotateCcw, Send, TimerOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FlowGraph } from "@/lib/flow-graph";
import { simReply, simStart, simTimeout, type SimState } from "@/lib/flow-simulator";

/** Chat as a test customer. Nothing is sent or billed. */
export function SimulatorPanel({ graph, onPath }: { graph: FlowGraph; onPath: (ids: string[]) => void }) {
  const [state, setState] = useState<SimState>(() => simStart(graph));
  const [text, setText] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onPath(state.path);
  }, [state.path, onPath]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [state.messages.length]);

  const send = (v: string) => {
    if (!v.trim()) return;
    setState((s) => simReply(graph, s, v));
    setText("");
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border pb-2">
        <p className="text-xs text-muted-foreground">Test chat — nothing is sent, nothing is billed.</p>
        <Button size="sm" variant="ghost" onClick={() => setState(simStart(graph))}><RotateCcw className="mr-1 h-4 w-4" /> Restart</Button>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto rounded-xl bg-muted/40 p-3">
        {state.messages.map((m, i) =>
          m.kind === "note" ? (
            <p key={i} className="text-center text-[11px] text-muted-foreground">{m.text}</p>
          ) : (
            <div key={i} className={`flex ${m.from === "customer" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm shadow-sm ${m.from === "customer" ? "rounded-br-sm bg-primary/15" : "rounded-bl-sm bg-card"}`}>
                {"image" in m && m.image && <img src={m.image} alt="" className="mb-2 max-h-40 w-full rounded-lg object-cover" />}
                <p className="whitespace-pre-wrap">{m.text}</p>
                {m.from === "bot" && m.options && (
                  <div className="mt-2 flex flex-col gap-1">
                    {m.options.map((o) => (
                      <button key={o} type="button" disabled={!state.waiting || i !== state.messages.length - 1} onClick={() => send(o)} className="rounded-lg border border-border py-1 text-xs font-medium text-primary transition hover:bg-primary/5 disabled:opacity-50">
                        {o}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ),
        )}
        <div ref={endRef} />
      </div>
      <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        <Input disabled={!state.waiting} placeholder={state.done ? "Flow ended" : state.waiting ? "Type a reply…" : ""} value={text} onChange={(e) => setText(e.target.value)} />
        <Button type="submit" size="icon" aria-label="Send" disabled={!state.waiting}><Send className="h-4 w-4" /></Button>
        <Button type="button" size="icon" variant="outline" aria-label="Simulate no reply" title="Simulate no reply" disabled={!state.waiting} onClick={() => setState((s) => simTimeout(graph, s))}><TimerOff className="h-4 w-4" /></Button>
      </form>
    </div>
  );
}
