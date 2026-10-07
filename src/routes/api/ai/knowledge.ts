import { createFileRoute } from "@tanstack/react-router";

/**
 * What the AI employee knows: adding, refreshing, opening and deleting the
 * things it has read. Reading needs ai.use; changing needs ai.configure.
 */
export const Route = createFileRoute("/api/ai/knowledge")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireOrgMember, requirePermission, isResponse, jsonError, logServerActivity } =
          await import("@/lib/whatsapp-api.server");

        let payload: Record<string, unknown>;
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          return jsonError("Invalid request.");
        }

        const auth = await requireOrgMember(request, (payload["organization_id"] as string) ?? null);
        if (isResponse(auth)) return auth;

        const action = String(payload["action"] ?? "list");
        const canUse = await requirePermission(auth, "ai.use", "see what the AI knows");
        if (canUse) return canUse;

        const configuring =
          action !== "list" && action !== "open" && action !== "gaps" && action !== "links" && action !== "price_reviews";
        if (configuring) {
          const denied = await requirePermission(auth, "ai.configure", "change what the AI knows");
          if (denied) return denied;
        }

        const knowledge = await import("@/lib/knowledge.server");

        try {
          if (action === "list") {
            const { data } = await auth.supabase
              .from("knowledge_sources")
              .select("id, type, name, status, item_count, pages_seen, last_synced_at, last_error, refresh_days, config, total_pages, products_found, last_manual_refresh_at, last_full_read_at")
              .eq("organization_id", auth.organizationId)
              .order("created_at", { ascending: false });
            const rows = (data ?? []) as Array<Record<string, unknown>>;
            // Reading facts for website sources: what's left, tonight's plan, buttons.
            const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
            const service = getServiceClient();
            const { loadKnowledgeAutoRefresh, loadReadingSettings } = await import("@/lib/reading.server");
            const [reading, plan, autoRefresh] = await Promise.all([
              loadReadingSettings(service),
              knowledge.planLimits(service, auth.organizationId),
              loadKnowledgeAutoRefresh(service),
            ]);
            const withFailed = await Promise.all(
              rows.map(async (r) => {
                const { count } = await auth.supabase
                  .from("knowledge_documents")
                  .select("id", { count: "exact", head: true })
                  .eq("source_id", String(r["id"]))
                  .eq("metadata->>prepare_failed", "true");
                return { ...r, failed_pages: count ?? 0 } as Record<string, unknown>;
              }),
            );
            const sources = await Promise.all(
              withFailed.map(async (r) => {
                if (r["type"] !== "website") return r;
                const { count } = await auth.supabase
                  .from("knowledge_urls")
                  .select("id", { count: "exact", head: true })
                  .eq("source_id", String(r["id"]))
                  .eq("status", "unread");
                const unread = count ?? 0;
                const room = Math.max(plan.cap - Number(r["pages_seen"] ?? 0), 0);
                // Coverage line: which customer answers the pages we read cover.
                const { data: pages } = await auth.supabase
                  .from("knowledge_documents")
                  .select("source_ref, title")
                  .eq("source_id", String(r["id"]))
                  .limit(5000);
                const { infoCoverage } = await import("@/lib/site-urls");
                const coverage = infoCoverage(
                  ((pages ?? []) as Array<{ source_ref: string; title: string | null }>).map((p) => ({ url: p.source_ref, title: p.title })),
                );
                const config = (r["config"] ?? {}) as Record<string, unknown>;
                const deleted = knowledge.isSoftDeleted({ status: String(r["status"] ?? ""), config });
                // Products by shelf, and how many still have no photo.
                let byCategory: Record<string, number> = {};
                let withoutPhoto = 0;
                try {
                  const origin = new URL(String(config["url"] ?? "")).origin;
                  const { data: prods } = await auth.supabase
                    .from("products")
                    .select("category, image_url")
                    .eq("organization_id", auth.organizationId)
                    .eq("source", "crawl")
                    .eq("is_visible", true)
                    .like("product_url", `${origin}%`)
                    .limit(20000);
                  for (const p of (prods ?? []) as Array<{ category: string | null; image_url: string | null }>) {
                    const shelf = p.category || "other";
                    byCategory[shelf] = (byCategory[shelf] ?? 0) + 1;
                    if (!p.image_url) withoutPhoto += 1;
                  }
                } catch {
                  byCategory = {};
                }
                // A plan's page limit counts pages a paid reader read; our own fetch is free.
                const paidCap = plan.paid ? plan.cap : Math.max(Number(reading.day0_page_limit) || 15, 1);
                const cooldownMs = reading.manual_refresh_cooldown_hours * 36e5;
                const last = r["last_manual_refresh_at"] ? new Date(String(r["last_manual_refresh_at"])).getTime() : 0;
                return {
                  ...r,
                  reading: {
                    unread,
                    plan_cap: plan.cap,
                    paid: plan.paid,
                    tonight: plan.paid && reading.backfill_pages_per_day > 0 ? Math.min(unread, room, reading.backfill_pages_per_day) : 0,
                    // No scheduled re-read while automatic re-reading is off: the
                    // screen never promises one (0 hides "refreshes every N days").
                    // Batch 16: and never for a trial workspace (manual re-reads only).
                    refresh_days: autoRefresh && plan.paid ? Number(r["refresh_days"] ?? 0) || reading.refresh_days : 0,
                    auto_refresh: autoRefresh,
                    can_read_more: unread > 0,
                    changes_available_at: last && Date.now() - last < cooldownMs ? new Date(last + cooldownMs).toISOString() : null,
                    coverage,
                    products_by_category: byCategory,
                    products_without_photo: withoutPhoto,
                    paid_pages: Number(config["paid_pages"] ?? 0) || 0,
                    paid_cap: paidCap,
                    paid_capped: config["paid_capped"] === true,
                    swap_blocked: (config["swap_blocked"] ?? null) as Record<string, unknown> | null,
                    unchanged_skipped: typeof config["unchanged_skipped"] === "number" ? config["unchanged_skipped"] : null,
                    discovery: typeof config["discovery"] === "string" ? config["discovery"] : "crawl",
                    keep_query: config["keep_query"] === true,
                  },
                  ...(deleted
                    ? {
                        deleted: {
                          at: String(config["deleted_at"]),
                          purge_after: String(config["purge_after"] ?? ""),
                          products: Array.isArray(config["deleted_products"]) ? config["deleted_products"].length : 0,
                        },
                      }
                    : {}),
                };
              }),
            );
            return Response.json({ sources });
          }

          if (action === "read_changes" || action === "read_more") {
            const sourceId = String(payload["source_id"] ?? "");
            const { data: row } = await auth.supabase
              .from("knowledge_sources")
              .select("id, type, status, pages_seen, config, last_manual_refresh_at")
              .eq("id", sourceId)
              .eq("organization_id", auth.organizationId)
              .maybeSingle();
            const src = row as { id: string; type: string; status: string; pages_seen: number | null; config: Record<string, unknown> | null; last_manual_refresh_at: string | null } | null;
            if (!src || src.type !== "website") return jsonError("That website isn't in this workspace.", 403);
            if (src.status === "syncing" || src.status === "pending") return jsonError("I'm already reading this site — give me a few minutes.", 409);
            const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
            const service = getServiceClient();
            const { loadReadingSettings } = await import("@/lib/reading.server");
            const reading = await loadReadingSettings(service);
            let config: Record<string, unknown>;
            const extra: Record<string, unknown> = {};
            if (action === "read_changes") {
              const cooldownMs = reading.manual_refresh_cooldown_hours * 36e5;
              const last = src.last_manual_refresh_at ? new Date(src.last_manual_refresh_at).getTime() : 0;
              if (last && Date.now() - last < cooldownMs)
                return jsonError(`I checked recently. You can ask again after ${new Date(last + cooldownMs).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}.`, 429);
              // The button also fills crawled products' missing photos,
              // descriptions and shelves (scheduled refreshes don't).
              config = { ...(src.config ?? {}), refresh: true, fill_products: true };
              // A fresh refresh. "Re-read whole site" reads only pages whose
              // sitemap date moved (unchanged text is never re-embedded either);
              // the scheduled weekly refresh is unchanged and reads them all.
              config["refresh_started_at"] = null;
              config["changed_only"] = true;
              extra["last_manual_refresh_at"] = new Date().toISOString();
            } else {
              // Pages our own fetch can read are free on every plan; the plan's
              // page limit applies to paid-reader pages inside the read.
              const { count } = await auth.supabase
                .from("knowledge_urls")
                .select("id", { count: "exact", head: true })
                .eq("source_id", src.id)
                .eq("status", "unread");
              if (!count) return jsonError("Every page I found is already read.", 409);
              config = { ...(src.config ?? {}), mode: "full", resume: true, refresh: false, pages_done: Number(src.pages_seen ?? 0), run_limit: null };
            }
            await auth.supabase
              .from("knowledge_sources")
              .update({ ...extra, config, status: "pending", queued_at: new Date().toISOString(), sync_started_at: null })
              .eq("id", src.id);
            await logServerActivity(auth.supabase, auth.organizationId, auth.userId, action === "read_changes" ? "knowledge_read_changes" : "knowledge_read_more", { source_id: src.id }).catch(() => undefined);
            return Response.json({ ok: true });
          }

          if (action === "retry_failed") {
            const sourceId = String(payload["source_id"] ?? "");
            const { data: row } = await auth.supabase
              .from("knowledge_sources")
              .select("id")
              .eq("id", sourceId)
              .eq("organization_id", auth.organizationId)
              .maybeSingle();
            if (!row) return jsonError("That source isn't in this workspace.", 403);
            const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
            const queued = await knowledge.retryFailedPreparation(getServiceClient(), auth.organizationId, sourceId);
            return Response.json({ ok: true, queued });
          }

          if (action === "open") {
            const sourceId = String(payload["source_id"] ?? "");
            if (!sourceId) return jsonError("Which source?");
            const { data } = await auth.supabase
              .from("knowledge_documents")
              .select("id, source_ref, title, content, updated_at")
              .eq("organization_id", auth.organizationId)
              .eq("source_id", sourceId)
              .order("title", { ascending: true })
              .limit(200);
            return Response.json({ documents: data ?? [] });
          }

          if (action === "add_website") {
            const discovery = payload["discovery"] === "sitemap" || payload["discovery"] === "links" ? payload["discovery"] : "crawl";
            const links =
              discovery === "links"
                ? String(payload["links"] ?? "")
                    .split(/[\s,]+/)
                    .map((l) => l.trim())
                    .filter((l) => /^https?:\/\//i.test(l))
                : [];
            const url = discovery === "links" ? (links[0] ?? "") : String(payload["url"] ?? "").trim();
            if (!/^https?:\/\//i.test(url)) return jsonError(discovery === "links" ? "Paste at least one full page address." : "Enter a full web address.");
            if (discovery === "links") {
              const { sameSite } = await import("@/lib/site-urls");
              const other = links.find((l) => !sameSite(l, url));
              if (other) return jsonError(`Every link must be on the same website as ${new URL(url).hostname} — add ${new URL(other).hostname} separately.`);
            }
            const added = await knowledge.addWebsiteSource(
              auth.supabase,
              auth.organizationId,
              url,
              auth.userId,
              { mode: "full", discovery, links, keepQuery: payload["keep_query"] === true },
            );
            if (added.limited) return jsonError(added.error ?? "Link limit reached.", 429);
            if (added.limited) return jsonError(added.error ?? "Link limit reached.", 429);
            if (!added.sourceId) return jsonError(added.error ?? "We couldn't add that website.");
            await logServerActivity(auth.supabase, auth.organizationId, auth.userId, "ai_knowledge_added", {
              type: "website",
            });
            return Response.json({
              source_id: added.sourceId,
              ok: added.ok,
              itemCount: added.itemCount,
              queued: added.queued ?? false,
              ...(added.error ? { error: added.error } : {}),
            });
          }


          if (action === "add_file") {
            const fileName = String(payload["file_name"] ?? "").trim();
            const base64 = String(payload["file_base64"] ?? "");
            const requested = String(payload["kind"] ?? "spreadsheet");
            const kind = (["pdf", "image", "docx"].includes(requested)
              ? requested
              : "spreadsheet") as "pdf" | "spreadsheet" | "image" | "docx";
            if (!fileName || !base64) return jsonError("Choose a file first.");
            const binary = atob(base64);
            if (binary.length > 8 * 1024 * 1024) {
              return jsonError("That file is larger than 8 MB. Split it and try again.");
            }
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);


            const { data, error } = await auth.supabase
              .from("knowledge_sources")
              .insert({
                organization_id: auth.organizationId,
                type: kind,
                name: fileName,
                config: { file_name: fileName },
                refresh_days: 0,
                created_by: auth.userId,
              })
              .select("id")
              .maybeSingle();
            if (error || !data) return jsonError("We couldn't add that file.");
            const sourceId = (data as { id: string }).id;
            const result = await knowledge.ingestUpload(
              auth.supabase,
              auth.organizationId,
              sourceId,
              fileName,
              bytes,
              kind,
            );
            await logServerActivity(auth.supabase, auth.organizationId, auth.userId, "ai_knowledge_added", {
              type: kind,
            });
            return Response.json({ source_id: sourceId, ...result });
          }

          if (action === "add_answer" || action === "correct") {
            const question = String(payload["question"] ?? "").trim();
            const answer = String(payload["answer"] ?? "").trim();
            if (!question || !answer) return jsonError("Write both the question and the answer.");
            const result = await knowledge.saveCorrection(auth.supabase, auth.organizationId, {
              question,
              answer,
              userId: auth.userId,
            });
            await logServerActivity(auth.supabase, auth.organizationId, auth.userId, "ai_answer_corrected", {});
            return Response.json(result);
          }

          if (action === "sync") {
            const sourceId = String(payload["source_id"] ?? "");
            if (!sourceId) return jsonError("Which source?");
            const { data: owned } = await auth.supabase
              .from("knowledge_sources")
              .select("id, type, status, config")
              .eq("id", sourceId)
              .eq("organization_id", auth.organizationId)
              .maybeSingle();
            if (!owned) return jsonError("That source isn't in this workspace.", 403);
            if (knowledge.isSoftDeleted(owned as { status?: string; config?: Record<string, unknown> | null }))
              return jsonError("That website was deleted — restore it first.", 409);
            const result = await knowledge.syncSource(auth.supabase, sourceId);
            // A shop read before we kept a catalogue catches up here: only its
            // product pages are fetched again, never the whole site.
            let productsFound = 0;
            if ((owned as { type?: string }).type === "website") {
              const { backfillProductsFromSource } = await import("@/lib/product-extract.server");
              productsFound = await backfillProductsFromSource(auth.supabase, sourceId);
            }
            return Response.json({ ...result, productsFound });
          }

          if (action === "delete_source") {
            const sourceId = String(payload["source_id"] ?? "");
            if (!sourceId) return jsonError("Which source?");
            const { data: target } = await auth.supabase
              .from("knowledge_sources")
              .select("id, type")
              .eq("id", sourceId)
              .eq("organization_id", auth.organizationId)
              .maybeSingle();
            if (!target) return jsonError("That source isn't in this workspace.", 403);
            // A website is never removed at once: Aiden stops using it now and
            // everything is kept for 7 days so it can be restored exactly.
            if ((target as { type?: string }).type === "website") {
              const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
              const removed = await knowledge.softDeleteWebsiteSource(getServiceClient(), auth.organizationId, sourceId, auth.userId);
              if (!removed.ok) return jsonError(removed.error ?? "We couldn't delete that website.", 409);
              await logServerActivity(auth.supabase, auth.organizationId, auth.userId, "ai_knowledge_removed", {
                type: "website",
                source_id: sourceId,
                pages: removed.pages,
                products: removed.products,
                restorable_until: removed.purgeAfter,
              });
              return Response.json({ ok: true, soft: true, pages: removed.pages, products: removed.products, purge_after: removed.purgeAfter });
            }
            await auth.supabase
              .from("knowledge_sources")
              .delete()
              .eq("id", sourceId)
              .eq("organization_id", auth.organizationId);
            await logServerActivity(auth.supabase, auth.organizationId, auth.userId, "ai_knowledge_removed", {});
            return Response.json({ ok: true });
          }

          if (action === "links") {
            const tab = ["read", "not_found", "excluded", "waiting"].includes(String(payload["tab"])) ? (String(payload["tab"]) as "read") : "read";
            const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
            const result = await knowledge.listWebsiteLinks(getServiceClient(), auth.organizationId, String(payload["source_id"] ?? ""), {
              tab,
              q: String(payload["q"] ?? ""),
              page: Number(payload["page"] ?? 0) || 0,
            });
            if (!result.ok) return jsonError(result.error ?? "That website isn't in this workspace.", 403);
            return Response.json(result);
          }

          if (action === "exclude_link" || action === "exclude_rule" || action === "include_link" || action === "remove_rule") {
            const sourceId = String(payload["source_id"] ?? "");
            const rule = { op: String(payload["op"] ?? ""), value: String(payload["value"] ?? "") } as import("@/lib/site-urls").ExcludeRule;
            const change =
              action === "exclude_link"
                ? { exclude_url: String(payload["url"] ?? ""), folder: payload["folder"] === true }
                : action === "include_link"
                  ? { include_url: String(payload["url"] ?? "") }
                  : action === "exclude_rule"
                    ? { exclude: rule }
                    : { remove_rule: rule };
            const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
            const result = await knowledge.changeWebsiteLinks(getServiceClient(), auth.organizationId, sourceId, change);
            if (!result.ok) return jsonError(result.error ?? "That didn't work.", 422);
            await logServerActivity(auth.supabase, auth.organizationId, auth.userId, "knowledge_links_changed", {
              source_id: sourceId,
              action,
              ...("exclude_url" in change ? { url: change.exclude_url, folder: change.folder } : {}),
              ...("include_url" in change ? { url: change.include_url } : {}),
              ...(action === "exclude_rule" || action === "remove_rule" ? { rule } : {}),
            });
            return Response.json(result);
          }

          if (action === "change_address") {
            const sourceId = String(payload["source_id"] ?? "");
            const url = String(payload["url"] ?? "").trim();
            if (!/^https?:\/\//i.test(url)) return jsonError("Enter a full web address.");
            const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
            const result = await knowledge.changeWebsiteAddress(getServiceClient(), auth.organizationId, sourceId, url);
            if (!result.ok) return jsonError(result.error ?? "We couldn't change that address.", 422);
            await logServerActivity(auth.supabase, auth.organizationId, auth.userId, "knowledge_address_changed", { source_id: sourceId, url: result.url });
            return Response.json(result);
          }

          if (action === "restore_source") {
            const sourceId = String(payload["source_id"] ?? "");
            if (!sourceId) return jsonError("Which source?");
            const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
            const restored = await knowledge.restoreWebsiteSource(getServiceClient(), auth.organizationId, sourceId);
            if (!restored.ok) return jsonError(restored.error ?? "We couldn't restore that website.", 409);
            await logServerActivity(auth.supabase, auth.organizationId, auth.userId, "knowledge_source_restored", {
              source_id: sourceId,
              products: restored.products,
            });
            return Response.json({ ok: true, products: restored.products });
          }

          if (action === "reread_page") {
            const sourceId = String(payload["source_id"] ?? "");
            const url = String(payload["url"] ?? "").trim();
            if (!sourceId) return jsonError("Which website?");
            if (!/^https?:\/\//i.test(url)) return jsonError("Paste the full address of the page.");
            const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
            const service = getServiceClient();
            if ((await knowledge.pageRereadsToday(service, auth.organizationId)) >= knowledge.PAGE_REREADS_PER_DAY)
              return jsonError(`You've re-read ${knowledge.PAGE_REREADS_PER_DAY} pages today — try again tomorrow, or use "Re-read whole site".`, 429);
            const result = await knowledge.rereadOnePage(service, auth.organizationId, sourceId, url);
            if (!result.ok) return jsonError(result.error ?? "I couldn't read that page.", 422);
            await logServerActivity(auth.supabase, auth.organizationId, auth.userId, "knowledge_page_reread", {
              source_id: sourceId,
              url,
              product: result.product ?? null,
            });
            return Response.json(result);
          }

          if (action === "delete_document") {
            const documentId = String(payload["document_id"] ?? "");
            if (!documentId) return jsonError("Which item?");
            await auth.supabase
              .from("knowledge_documents")
              .delete()
              .eq("id", documentId)
              .eq("organization_id", auth.organizationId);
            await logServerActivity(auth.supabase, auth.organizationId, auth.userId, "ai_knowledge_removed", {});
            return Response.json({ ok: true });
          }

          if (action === "corrections") {
            const { data: source } = await auth.supabase
              .from("knowledge_sources")
              .select("id")
              .eq("organization_id", auth.organizationId)
              .eq("type", "manual_qa")
              .limit(1)
              .maybeSingle();
            if (!source) return Response.json({ corrections: [] });
            const { data } = await auth.supabase
              .from("knowledge_documents")
              .select("id, title, content, use_count, last_used_at, created_at")
              .eq("organization_id", auth.organizationId)
              .eq("source_id", (source as { id: string }).id)
              .order("created_at", { ascending: false })
              .limit(200);
            const corrections = ((data ?? []) as Array<Record<string, unknown>>).map((d) => {
              const content = String(d["content"] ?? "");
              const answer = content.split(/\nAnswer:\s*/)[1] ?? content;
              return {
                id: d["id"],
                question: d["title"],
                answer,
                use_count: d["use_count"] ?? 0,
                last_used_at: d["last_used_at"] ?? null,
                created_at: d["created_at"],
              };
            });
            return Response.json({ corrections });
          }

          if (action === "update_correction") {
            const documentId = String(payload["document_id"] ?? "");
            const question = String(payload["question"] ?? "").trim();
            const answer = String(payload["answer"] ?? "").trim();
            if (!documentId || !question || !answer)
              return jsonError("Write both the question and the answer.");
            await auth.supabase
              .from("knowledge_documents")
              .delete()
              .eq("id", documentId)
              .eq("organization_id", auth.organizationId);
            const result = await knowledge.saveCorrection(auth.supabase, auth.organizationId, {
              question,
              answer,
              userId: auth.userId,
            });
            await logServerActivity(auth.supabase, auth.organizationId, auth.userId, "ai_answer_corrected", {
              edited: true,
            });
            return Response.json(result);
          }

          // Batch 16: a product page whose price moved by more than half —
          // the daily check never applies that on its own.
          if (action === "price_reviews") {
            const { priceReviews } = await import("@/lib/price-check.server");
            return Response.json({ reviews: await priceReviews(auth.supabase, auth.organizationId) });
          }
          if (action === "resolve_price_review") {
            const productId = String(payload["product_id"] ?? "");
            if (!productId) return jsonError("Which product?");
            const { resolvePriceReview } = await import("@/lib/price-check.server");
            const apply = payload["apply"] === true;
            const result = await resolvePriceReview(auth.supabase, auth.organizationId, productId, apply);
            if (!result.ok) return jsonError(result.error ?? "Couldn't save that.", 400);
            await logServerActivity(auth.supabase, auth.organizationId, auth.userId, "price_review_resolved", {
              product_id: productId,
              applied: apply,
            });
            return Response.json({ ok: true });
          }

          if (action === "gaps") {
            const page = Math.max(0, Number(payload["page"] ?? 0));
            const size = 20;
            const { data, count } = await auth.supabase
              .from("pending_owner_replies")
              .select("id, question, status, source, conversation_id, created_at", {
                count: "exact",
              })
              .eq("organization_id", auth.organizationId)
              .in("status", ["pending", "expired"])
              .order("created_at", { ascending: false })
              .range(page * size, page * size + size - 1);
            const { count: waiting } = await auth.supabase
              .from("pending_owner_replies")
              .select("id", { count: "exact", head: true })
              .eq("organization_id", auth.organizationId)
              .eq("status", "pending");
            return Response.json({
              gaps: data ?? [],
              total: count ?? 0,
              waiting: waiting ?? 0,
              page,
              page_size: size,
            });
          }

          if (action === "answer_gap" || action === "dismiss_gap") {
            const replyId = String(payload["reply_id"] ?? "");
            if (!replyId) return jsonError("Which question?");
            const { data: row } = await auth.supabase
              .from("pending_owner_replies")
              .select("id, organization_id, owner_phone, conversation_id, contact_id, question, source, status, selected_at, created_at, reminded_at")
              .eq("id", replyId)
              .eq("organization_id", auth.organizationId)
              .maybeSingle();
            if (!row) return jsonError("That question isn't in this workspace.", 403);
            const pending = row as {
              id: string;
              organization_id: string;
              owner_phone: string;
              conversation_id: string | null;
              contact_id: string | null;
              question: string;
              source: string;
              status: string;
              selected_at: string | null;
              created_at: string;
              reminded_at: string | null;
            };

            if (action === "dismiss_gap") {
              await auth.supabase
                .from("pending_owner_replies")
                .update({ status: "expired" })
                .eq("id", pending.id)
                .eq("organization_id", auth.organizationId);
              return Response.json({ ok: true });
            }

            const answer = String(payload["answer"] ?? "").trim();
            if (!answer) return jsonError("Write the answer first.");
            // Answers typed on the dashboard always count as answers.

            await knowledge.saveCorrection(auth.supabase, auth.organizationId, {
              question: pending.question,
              answer,
              userId: auth.userId,
            });

            let delivered = false;
            if (pending.status === "pending" && pending.conversation_id) {
              try {
                const { deliverToCustomer } = await import("@/lib/owner-replies.server");
                delivered = await deliverToCustomer(auth.supabase, pending, answer);
              } catch (sendError) {
                console.error(
                  "[ai-knowledge] gap delivery failed",
                  sendError instanceof Error ? sendError.message : sendError,
                );
              }
            }

            await auth.supabase
              .from("pending_owner_replies")
              .update({
                status: "answered",
                answer,
                answered_at: new Date().toISOString(),
                selected_at: new Date().toISOString(),
              })
              .eq("id", pending.id)
              .eq("organization_id", auth.organizationId);

            await logServerActivity(
              auth.supabase,
              auth.organizationId,
              auth.userId,
              "ai_answer_corrected",
              { from: "unanswered" },
            );

            return Response.json({ ok: true, delivered });
          }

          return jsonError("Unknown action.");

        } catch (error) {
          const message = error instanceof Error ? error.message : "That didn't work.";
          console.error("[ai-knowledge] failed", action, message);
          return Response.json({ error: message }, { status: 500 });
        }
      },
    },
  },
});
