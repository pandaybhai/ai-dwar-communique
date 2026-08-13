import { createFileRoute } from "@tanstack/react-router";

type AnyRecord = Record<string, unknown>;

export const Route = createFileRoute("/api/whatsapp/templates")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const {
          requireOrgMember,
          isResponse,
          jsonError,
          graphFetch,
          graphErrorMessage,
          logServerActivity,
        } = await import("@/lib/whatsapp-api.server");
        const { slugifyTemplateName, extractVariables } = await import("@/lib/templates");

        let payload: AnyRecord;
        try {
          payload = (await request.json()) as AnyRecord;
        } catch {
          return jsonError("Invalid request.");
        }

        const auth = await requireOrgMember(request, (payload["organization_id"] as string) ?? null);
        if (isResponse(auth)) return auth;
        if (auth.role !== "owner" && auth.role !== "admin") {
          return jsonError("Only owners and admins can manage templates.", 403);
        }
        const { supabase, organizationId, userId } = auth;

        const { data: account } = await supabase
          .from("whatsapp_accounts")
          .select("waba_id")
          .eq("organization_id", organizationId)
          .eq("status", "active")
          .order("connected_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!account?.waba_id) {
          return jsonError("Connect your business number before managing templates.", 400);
        }

        const { data: cred } = await supabase
          .from("whatsapp_credentials")
          .select("access_token")
          .eq("organization_id", organizationId)
          .maybeSingle();
        if (!cred?.access_token) {
          return jsonError("Your credentials are missing. Reconnect the number.", 400);
        }

        const action = String(payload["action"] ?? "sync");
        const nowIso = new Date().toISOString();

        // ---------------- sync ----------------
        if (action === "sync") {
          const result = await graphFetch(`${account.waba_id}/message_templates`, cred.access_token, {
            query: { limit: "200", fields: "id,name,language,category,status,components,rejected_reason" },
          });
          if (!result.ok) {
            return Response.json({ error: graphErrorMessage(result.body) }, { status: 400 });
          }

          const rows = (result.body["data"] as AnyRecord[] | undefined) ?? [];
          let synced = 0;
          for (const t of rows) {
            const name = String(t["name"] ?? "");
            if (!name) continue;
            const rejected = t["rejected_reason"] as string | undefined;
            const { error } = await supabase.from("message_templates").upsert(
              {
                organization_id: organizationId,
                meta_template_id: String(t["id"] ?? "") || null,
                name,
                language: String(t["language"] ?? "en_US"),
                category: (t["category"] as string) ?? null,
                status: String(t["status"] ?? "PENDING").toUpperCase(),
                components: (t["components"] as unknown) ?? [],
                rejection_reason:
                  rejected && rejected !== "NONE" ? String(rejected) : null,
                updated_at: nowIso,
              },
              { onConflict: "organization_id,name,language" },
            );
            if (!error) synced += 1;
          }

          await logServerActivity(supabase, organizationId, userId, "template_synced", {
            count: synced,
          });
          return Response.json({ synced, total: rows.length, synced_at: nowIso });
        }

        // ---------------- create ----------------
        if (action === "create") {
          const name = slugifyTemplateName(String(payload["name"] ?? ""));
          const language = String(payload["language"] ?? "en_US");
          const category = String(payload["category"] ?? "").toUpperCase();
          const body = String(payload["body"] ?? "").trim();
          const footer = String(payload["footer"] ?? "").trim();
          const examples = (payload["examples"] as string[] | undefined) ?? [];

          if (!name) return jsonError("A template name is required.");
          if (!["MARKETING", "UTILITY", "AUTHENTICATION"].includes(category)) {
            return jsonError("Choose a valid category.");
          }
          if (!body) return jsonError("Template body text is required.");

          const variables = extractVariables(body);
          if (variables.some((v, i) => v !== i + 1)) {
            return jsonError("Variables must be numbered in order, starting at {{1}}.");
          }
          if (variables.length && examples.filter((e) => e && e.trim()).length !== variables.length) {
            return jsonError("Give an example value for every variable — Meta requires them.");
          }

          const components: AnyRecord[] = [
            {
              type: "BODY",
              text: body,
              ...(variables.length
                ? { example: { body_text: [examples.map((e) => e.trim())] } }
                : {}),
            },
          ];
          if (footer) components.push({ type: "FOOTER", text: footer });

          const result = await graphFetch(
            `${account.waba_id}/message_templates`,
            cred.access_token,
            { method: "POST", body: { name, language, category, components } },
          );
          if (!result.ok) {
            return Response.json(
              { error: graphErrorMessage(result.body), provider_response: result.body },
              { status: 400 },
            );
          }

          const metaId = (result.body["id"] as string) ?? null;
          const status = String(result.body["status"] ?? "PENDING").toUpperCase();

          const { data: saved, error: saveErr } = await supabase
            .from("message_templates")
            .upsert(
              {
                organization_id: organizationId,
                meta_template_id: metaId,
                name,
                language,
                category,
                status: ["PENDING", "APPROVED", "REJECTED", "PAUSED"].includes(status)
                  ? status
                  : "PENDING",
                components,
                rejection_reason: null,
                updated_at: nowIso,
              },
              { onConflict: "organization_id,name,language" },
            )
            .select("id")
            .single();

          if (saveErr) {
            return jsonError("Submitted to review, but we couldn't save it locally. Try syncing.", 500);
          }

          await logServerActivity(supabase, organizationId, userId, "template_created", {
            template_name: name,
            language,
            category,
          });

          return Response.json({ id: saved?.id ?? null, meta_template_id: metaId, status });
        }

        return jsonError("Unsupported action.");
      },
    },
  },
});
