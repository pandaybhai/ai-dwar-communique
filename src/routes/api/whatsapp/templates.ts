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
        const { requirePermission } = await import("@/lib/whatsapp-api.server");
        const denied = await requirePermission(auth, "templates.manage", "manage message templates");
        if (denied) return denied;
        const { supabase, organizationId, userId } = auth;

        const { getWhatsAppConnection, listWabaConnections } = await import(
          "@/lib/whatsapp-numbers.server"
        );
        // Templates live inside a WABA, not inside a workspace. An org with two
        // business accounts has two separate libraries.
        const requestedAccountId = (payload["whatsapp_account_id"] as string | undefined) || null;

        const action = String(payload["action"] ?? "sync");
        const nowIso = new Date().toISOString();

        // ---------------- sync ----------------
        if (action === "sync") {
          // Sync per WABA — one number's library must never overwrite another's.
          let targets: Array<{ wabaId: string; accessToken: string }>;
          if (requestedAccountId) {
            const { connection, error } = await getWhatsAppConnection(
              supabase,
              organizationId,
              requestedAccountId,
            );
            if (!connection) return jsonError(error ?? "No connected number.", 400);
            targets = [{ wabaId: connection.wabaId, accessToken: connection.accessToken }];
          } else {
            targets = await listWabaConnections(supabase, organizationId);
          }
          if (targets.length === 0) {
            return jsonError("Connect your business number before managing templates.", 400);
          }

          let synced = 0;
          let total = 0;
          const failures: string[] = [];

          for (const target of targets) {
            const result = await graphFetch(
              `${target.wabaId}/message_templates`,
              target.accessToken,
              {
                query: {
                  limit: "200",
                  fields: "id,name,language,category,status,components,rejected_reason",
                },
              },
            );
            if (!result.ok) {
              failures.push(graphErrorMessage(result.body));
              continue;
            }

            const rows = (result.body["data"] as AnyRecord[] | undefined) ?? [];
            total += rows.length;
            for (const t of rows) {
              const name = String(t["name"] ?? "");
              if (!name) continue;
              const rejected = t["rejected_reason"] as string | undefined;
              const { error } = await supabase.from("message_templates").upsert(
                {
                  organization_id: organizationId,
                  waba_id: target.wabaId,
                  meta_template_id: String(t["id"] ?? "") || null,
                  name,
                  language: String(t["language"] ?? "en_US"),
                  category: (t["category"] as string) ?? null,
                  status: String(t["status"] ?? "PENDING").toUpperCase(),
                  components: (t["components"] as unknown) ?? [],
                  rejection_reason: rejected && rejected !== "NONE" ? String(rejected) : null,
                  updated_at: nowIso,
                },
                { onConflict: "organization_id,waba_id,name,language" },
              );
              if (!error) synced += 1;
            }
          }

          if (synced === 0 && failures.length > 0) {
            return Response.json({ error: failures[0] }, { status: 400 });
          }

          await logServerActivity(supabase, organizationId, userId, "template_synced", {
            count: synced,
            waba_count: targets.length,
          });
          return Response.json({ synced, total, synced_at: nowIso });
        }

        // ---------------- create ----------------
        if (action === "create") {
          const { connection, error: connectionError } = await getWhatsAppConnection(
            supabase,
            organizationId,
            requestedAccountId,
          );
          if (!connection) return jsonError(connectionError ?? "No connected number.", 400);

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
            `${connection.wabaId}/message_templates`,
            connection.accessToken,
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
                waba_id: connection.wabaId,
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
              { onConflict: "organization_id,waba_id,name,language" },
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
            whatsapp_account_id: connection.accountId,
          });

          return Response.json({ id: saved?.id ?? null, meta_template_id: metaId, status });
        }

        return jsonError("Unsupported action.");
      },
    },
  },
});
