import { Fragment, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Link2 } from "lucide-react";

/** Small pieces every docs page uses (Batch 38 item 9). */

/** An HTTP method, coloured. `short` writes DELETE as DEL where room is tight (the sidebar, lists). */
export function MethodBadge({
  method,
  className = "",
  short = false,
}: {
  method: string;
  className?: string;
  short?: boolean;
}) {
  return (
    <span
      className={`docs-method docs-method-${method} ${className}`}
      {...(short && method === "DELETE" ? { title: "DELETE" } : {})}
    >
      {short && method === "DELETE" ? "DEL" : method}
    </span>
  );
}

/** A link inside the docs: the router for our own pages, a plain link for files and other sites. */
export function DocLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  const own = href.startsWith("/developers") && !/\.(json|txt)$/.test(href);
  if (own)
    return (
      <Link to={href} className={className}>
        {children}
      </Link>
    );
  const file = /\.(json|txt)$/.test(href);
  return (
    <a
      href={href}
      className={className}
      {...(file ? { download: href.endsWith(".json") ? "" : undefined } : {})}
    >
      {children}
    </a>
  );
}

/**
 * Inline text: `code`, **bold**, *italic* and [links](/path). Anything else
 * is plain text (React escapes it).
 */
export function InlineText({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let k = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(<Fragment key={k++}>{text.slice(last, m.index)}</Fragment>);
    if (m[1] !== undefined)
      out.push(
        <code key={k++} className="docs-inline">
          {m[1]}
        </code>,
      );
    else if (m[2] !== undefined)
      out.push(
        <strong key={k++} className="font-semibold text-[var(--d-fg)]">
          <InlineText text={m[2]} />
        </strong>,
      );
    else if (m[3] !== undefined) out.push(<em key={k++}>{m[3]}</em>);
    else
      out.push(
        <DocLink key={k++} href={m[5]!}>
          <InlineText text={m[4]!} />
        </DocLink>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(<Fragment key={k++}>{text.slice(last)}</Fragment>);
  return <>{out}</>;
}

export function Heading({
  id,
  level,
  children,
}: {
  id: string;
  level: 2 | 3;
  children: ReactNode;
}) {
  const Tag = level === 2 ? "h2" : "h3";
  return (
    <Tag
      id={id}
      className={`docs-heading group flex scroll-mt-24 items-center gap-2 font-semibold tracking-tight text-[var(--d-fg)] ${
        level === 2 ? "text-[22px] leading-snug" : "text-lg"
      }`}
    >
      <span>{children}</span>
      <a
        href={`#${id}`}
        className="docs-anchor docs-plain text-[var(--d-faint)] hover:text-[var(--d-accent)]"
        aria-label={`Link to this section`}
      >
        <Link2 className="h-4 w-4" aria-hidden="true" />
      </a>
    </Tag>
  );
}
