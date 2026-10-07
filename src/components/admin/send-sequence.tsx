import type { SendStep } from "@/lib/reply-order";

/**
 * A test reply as the customer would see it: each text, and each picture with
 * its caption under it, numbered in send order. Never sent anywhere.
 */
export function SendSequence({ steps, compact = false }: { steps: SendStep[]; compact?: boolean }) {
  const pictures = steps.filter((s) => s.kind === "picture").length;
  return (
    <ol className="space-y-2" aria-label="Messages in the order they would be sent">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-2">
          <span className="mt-1 h-5 min-w-5 rounded-full bg-muted px-1.5 text-center text-[11px] leading-5 text-muted-foreground">{i + 1}</span>
          {s.kind === "text" ? (
            <p className="whitespace-pre-wrap text-sm">{s.text}</p>
          ) : (
            <figure className={`w-full ${compact ? "max-w-[150px]" : "max-w-[260px]"} overflow-hidden rounded-xl border border-border/70 bg-background`}>
              <img src={s.image_url} alt={s.title} className="aspect-square w-full object-cover" loading="lazy" />
              <figcaption className="whitespace-pre-wrap break-words px-2 py-1.5 text-xs text-foreground">
                {s.caption.trim() ? s.caption : <span className="italic text-muted-foreground">No caption</span>}
              </figcaption>
            </figure>
          )}
        </li>
      ))}
      {pictures > 0 ? (
        <li className="pl-7 text-[11px] text-muted-foreground">
          {pictures} {pictures === 1 ? "picture" : "pictures"} · with the WhatsApp shop on, products go as catalogue cards in the same order.
          {pictures > 1 ? " The first product of a group arrives first; the rest are sent together, so WhatsApp may show them in another order." : ""}
        </li>
      ) : null}
    </ol>
  );
}
