import { Lock, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { ToolRow } from "@/lib/employee-client";

/** What the employee is allowed to look up or do on your behalf. */
export function ToolsList({ tools }: { tools: ToolRow[] }) {
  const available = tools.filter((t) => t.available);
  return (
    <section
      aria-labelledby="tools-heading"
      className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="tools-heading" className="flex items-center gap-2 text-lg font-semibold text-foreground">
            <Wrench className="h-5 w-5 text-primary" />
            What it can look up
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            It can only use what's switched on here. Anything greyed out, it simply cannot touch.
          </p>
        </div>
        <Badge variant="secondary">{available.length} of {tools.length} available</Badge>
      </div>

      <ul className="mt-6 grid gap-3 md:grid-cols-2">
        {tools.map((tool) => (
          <li
            key={tool.name}
            className={`rounded-xl border p-4 transition-colors ${
              tool.available ? "border-border/70 bg-muted/20" : "border-dashed border-border/60 bg-muted/10"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <p
                className={`text-sm font-medium ${
                  tool.available ? "text-foreground" : "text-muted-foreground"
                }`}
              >
                {tool.description}
              </p>
              {tool.available ? (
                <Badge variant={tool.access === "write" ? "default" : "secondary"} className="shrink-0">
                  {tool.access === "write" ? "Can change things" : "Read only"}
                </Badge>
              ) : (
                <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              )}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              {tool.available ? tool.name : tool.reason}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
