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

        const configuring = action !== "list" && action !== "open";
        if (configuring) {
          const denied = await requirePermission(auth, "ai.configure", "change what the AI knows");
          if (denied) return denied;
        }

        const knowledge = await import("@/lib/knowledge.server");

        try {
          if (action === "list") {
            const { data } = await auth.supabase
              .from("knowledge_sources")
              .select("id, type, name, status, item_count, last_synced_at, last_error, refresh_days, config")
              .eq("organization_id", auth.organizationId)
              .order("created_at", { ascending: false });
            return Response.json({ sources: data ?? [] });
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
            const url = String(payload["url"] ?? "").trim();
            if (!/^https?:\/\//i.test(url)) return jsonError("Enter a full web address.");
            const { data, error } = await auth.supabase
              .from("knowledge_sources")
              .insert({
                organization_id: auth.organizationId,
                type: "website",
                name: new URL(url).hostname,
                config: { url, page_cap: 40 },
                refresh_days: 7,
                created_by: auth.userId,
              })
              .select("id")
              .maybeSingle();
            if (error || !data) return jsonError("We couldn't add that website.");
            const sourceId = (data as { id: string }).id;
            const result = await knowledge.syncSource(auth.supabase, sourceId);
            await logServerActivity(auth.supabase, auth.organizationId, auth.userId, "ai_knowledge_added", {
              type: "website",
            });
            return Response.json({ source_id: sourceId, ...result });
          }

          if (action === "add_file") {
            const fileName = String(payload["file_name"] ?? "").trim();
            const base64 = String(payload["file_base64"] ?? "");
            const kind = payload["kind"] === "pdf" ? "pdf" : "spreadsheet";
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
              .select("id")
              .eq("id", sourceId)
              .eq("organization_id", auth.organizationId)
              .maybeSingle();
            if (!owned) return jsonError("That source isn't in this workspace.", 403);
            const result = await knowledge.syncSource(auth.supabase, sourceId);
            return Response.json(result);
          }

          if (action === "delete_source") {
            const sourceId = String(payload["source_id"] ?? "");
            if (!sourceId) return jsonError("Which source?");
            await auth.supabase
              .from("knowledge_sources")
              .delete()
              .eq("id", sourceId)
              .eq("organization_id", auth.organizationId);
            await logServerActivity(auth.supabase, auth.organizationId, auth.userId, "ai_knowledge_removed", {});
            return Response.json({ ok: true });
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
