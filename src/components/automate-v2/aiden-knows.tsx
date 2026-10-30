import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  BookOpen,
  FileText,
  Globe,
  MessageCircleQuestion,
  ShoppingBag,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { aidwar } from "@/integrations/aidwar/client";
import { NOT_ARCHIVED_DUPLICATE } from "@/lib/catalog";
import type { KnowledgeSource } from "@/lib/employee-client";
import { cn } from "@/lib/utils";
import { knowsRows, type KnowsRow } from "./aiden-v2";
import { knowsCopy as t } from "./copy";

const ICONS: Record<KnowsRow["key"], LucideIcon> = {
  website: Globe,
  documents: FileText,
  answers: MessageCircleQuestion,
  catalogue: ShoppingBag,
};

const STATE_TEXT: Partial<Record<KnowsRow["state"], string>> = {
  reading: t.reading,
  problem: t.problem,
};

/**
 * Batch 49: "What Aiden knows" on Automate > Aiden: the knowledge sources the
 * Employee overview already returned, and the catalogue's size and newest
 * change (the same two reads as the Products page's summary line). Read only;
 * "Manage" opens the existing What I know tab.
 */
export function AidenKnows({
  organizationId,
  name,
  sources,
  catalogueOn,
  onManage,
}: {
  organizationId: string;
  name: string;
  sources: KnowledgeSource[];
  /** The catalogs flag and catalog.view: only then is the catalogue row shown. */
  catalogueOn: boolean;
  onManage: () => void;
}) {
  const [catalogue, setCatalogue] = useState<{
    products: number;
    lastUpdated: string | null;
  } | null>(null);

  useEffect(() => {
    if (!catalogueOn) return;
    let live = true;
    void Promise.all([
      aidwar
        .from("products")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .or(NOT_ARCHIVED_DUPLICATE),
      aidwar
        .from("products")
        .select("updated_at")
        .eq("organization_id", organizationId)
        .order("updated_at", { ascending: false })
        .limit(1),
    ]).then(([total, latest]) => {
      if (!live) return;
      setCatalogue({
        products: total.count ?? 0,
        lastUpdated:
          ((latest.data ?? []) as Array<{ updated_at: string | null }>)[0]?.updated_at ?? null,
      });
    });
    return () => {
      live = false;
    };
  }, [organizationId, catalogueOn]);

  const rows = knowsRows(sources, catalogueOn ? catalogue : null);

  return (
    <section aria-labelledby="aiden-knows-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="aiden-knows-heading" className="m-0 font-display text-[1.25rem] font-semibold">
          {t.heading(name)}
        </h2>
        <Button variant="ghost" size="sm" className="phone:h-11" onClick={onManage}>
          <BookOpen className="mr-1.5 h-4 w-4" aria-hidden="true" /> {t.manage}
        </Button>
      </div>
      <ul className="m-0 flex list-none flex-col rounded-[20px] border border-line bg-surface p-0 shadow-md">
        {rows.map((row) => {
          const Icon = ICONS[row.key];
          const state = STATE_TEXT[row.state];
          const body = (
            <>
              <span
                aria-hidden="true"
                className={cn(
                  "grid h-10 w-10 shrink-0 place-items-center rounded-full",
                  row.state === "empty"
                    ? "bg-bubble-in text-muted-foreground"
                    : "bg-aiden-soft text-aiden-deep",
                )}
              >
                <Icon className="h-[18px] w-[18px]" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-semibold text-foreground">{row.label}</span>
                <span className="text-sm text-muted-foreground">{row.detail}</span>
              </span>
              {state ? (
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2.5 py-1 text-[13px] font-semibold",
                    row.state === "problem"
                      ? "bg-gold-bg text-gold-ink"
                      : "bg-aiden-soft text-aiden-deep",
                  )}
                >
                  {state}
                </span>
              ) : null}
            </>
          );
          return (
            <li key={row.key} className="border-b border-line last:border-b-0">
              {row.key === "catalogue" ? (
                <Link
                  to="/app/catalog"
                  className="flex items-center gap-3.5 rounded-[20px] px-4 py-3.5 transition-[background-color] duration-200 hover:bg-ground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-aiden"
                >
                  {body}
                </Link>
              ) : (
                <div className="flex items-center gap-3.5 px-4 py-3.5">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
