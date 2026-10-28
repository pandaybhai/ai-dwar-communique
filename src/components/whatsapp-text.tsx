import { Fragment, type ReactNode } from "react";
import { parseWhatsAppText, type InlineNode } from "@/lib/wa-format";

function renderNodes(nodes: InlineNode[], key = ""): ReactNode[] {
  return nodes.map((node, i) => {
    const k = `${key}${i}`;
    if ("text" in node) return <Fragment key={k}>{node.text}</Fragment>;
    const children = renderNodes(node.children, `${k}-`);
    switch (node.style) {
      case "bold":
        return (
          <strong key={k} className="font-semibold">
            {children}
          </strong>
        );
      case "italic":
        return <em key={k}>{children}</em>;
      case "strike":
        return <s key={k}>{children}</s>;
      case "mono":
        return (
          <code key={k} className="whitespace-pre-wrap font-mono text-[0.92em]">
            {children}
          </code>
        );
      case "code":
        return (
          <code key={k} className="rounded bg-muted/70 px-1 font-mono text-[0.92em]">
            {children}
          </code>
        );
    }
  });
}

/**
 * Batch 35: message text shown the way WhatsApp shows it — bold, italic,
 * strikethrough, monospace, lists and quotes. Display only; render it inside
 * an element that keeps line breaks (whitespace-pre-wrap).
 */
export function WhatsAppText({ text }: { text: string }) {
  const lines = parseWhatsAppText(text);
  return (
    <>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {line.kind === "quote" ? (
            <span className="inline-block border-l-2 border-current/30 pl-2 opacity-80">
              {renderNodes(line.nodes)}
            </span>
          ) : line.kind === "bullet" || line.kind === "number" ? (
            <span className="inline-flex gap-1.5">
              <span aria-hidden="true">{line.marker}</span>
              <span>{renderNodes(line.nodes)}</span>
            </span>
          ) : (
            renderNodes(line.nodes)
          )}
          {i < lines.length - 1 ? "\n" : null}
        </Fragment>
      ))}
    </>
  );
}
