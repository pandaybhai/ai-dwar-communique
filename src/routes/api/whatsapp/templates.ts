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
        const {
          slugifyTemplateName,
          extractVariables,
          validateDraft,
          draftToComponents,
          annotateStoredComponents,
          emptyDraft,
        } = await import("@/lib/templates");

        let payload: AnyRecord;
        try {
          payload = (await request.json()) as AnyRecord;
        } catch {
          return jsonError("Invalid request.");
        }

        const auth = await requireOrgMember(
          request,
          (payload["organization_id"] as string) ?? null,
        );
        if (isResponse(auth)) return auth;
        const { requirePermission } = await import("@/lib/whatsapp-api.server");
        const denied = await requirePermission(
          auth,
          "templates.manage",
          "manage message templates",
        );
        if (denied) return denied;
        const { supabase, organizationId, userId } = auth;

        const { getWhatsAppConnection, listWabaConnections } =
          await import("@/lib/whatsapp-numbers.server");
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

            // What we already hold for this WABA. Meta hands back its own
            // expiring upload handle and nothing else, so we re-attach the
            // media links we stored when the template was built — otherwise a
            // sync quietly strips the picture off every media template.
            const { preserveMediaUrls } = await import("@/lib/templates");
            const { data: storedRows } = await supabase
              .from("message_templates")
              .select("name, language, components")
              .eq("organization_id", organizationId)
              .eq("waba_id", target.wabaId);
            const stored = new Map<string, unknown>(
              ((storedRows as Array<AnyRecord> | null) ?? []).map((r) => [
                `${String(r["name"])}|${String(r["language"])}`,
                r["components"],
              ]),
            );

            for (const t of rows) {
              const name = String(t["name"] ?? "");
              if (!name) continue;
              const language = String(t["language"] ?? "en_US");
              const rejected = t["rejected_reason"] as string | undefined;
              const incoming = ((t["components"] as unknown) ?? []) as Parameters<
                typeof preserveMediaUrls
              >[0];
              const merged = preserveMediaUrls(
                incoming,
                (stored.get(`${name}|${language}`) ?? null) as Parameters<
                  typeof preserveMediaUrls
                >[1],
              );
              const { error } = await supabase.from("message_templates").upsert(
                {
                  organization_id: organizationId,
                  waba_id: target.wabaId,
                  meta_template_id: String(t["id"] ?? "") || null,
                  name,
                  language,
                  category: (t["category"] as string) ?? null,
                  status: String(t["status"] ?? "PENDING").toUpperCase(),
                  components: merged,
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
          // The builder sends the whole draft. Older callers send just a body
          // and a footer, so both shapes are accepted and validated the same way.
          const incoming = (payload["draft"] as AnyRecord | undefined) ?? null;
          const draft = incoming
            ? { ...emptyDraft(), ...(incoming as unknown as ReturnType<typeof emptyDraft>) }
            : {
                ...emptyDraft(),
                name: String(payload["name"] ?? ""),
                language: String(payload["language"] ?? "en_US"),
                category: String(payload["category"] ?? "").toUpperCase(),
                body: String(payload["body"] ?? "").trim(),
                footer: String(payload["footer"] ?? "").trim(),
                bodyExamples: Object.fromEntries(
                  extractVariables(String(payload["body"] ?? "")).map((v, i) => [
                    v,
                    ((payload["examples"] as string[] | undefined) ?? [])[i] ?? "",
                  ]),
                ),
              };

          const { createTemplateFromDraft } = await import("@/lib/template-create.server");
          const created = await createTemplateFromDraft(supabase, {
            organizationId,
            userId,
            draft: draft as Parameters<typeof createTemplateFromDraft>[1]["draft"],
            whatsappAccountId: requestedAccountId,
          });
          if (!created.ok) {
            return Response.json(
              { error: created.error, provider_response: created.providerResponse ?? null },
              { status: 400 },
            );
          }
          return Response.json({
            id: created.id,
            meta_template_id: created.metaTemplateId,
            status: created.status,
          });
        }

        // -------- create the two cash-on-delivery messages in one go --------
        if (action === "create_cod_templates") {
          const { connection, error: connectionError } = await getWhatsAppConnection(
            supabase,
            organizationId,
            requestedAccountId,
          );
          if (!connection) return jsonError(connectionError ?? "No connected number.", 400);

          const language = String(payload["language"] ?? "en_US");
          const buttons = {
            type: "BUTTONS",
            buttons: [
              { type: "QUICK_REPLY", text: "Yes, confirm" },
              { type: "QUICK_REPLY", text: "No, cancel" },
            ],
          };
          const specs = [
            {
              name: "cod_confirm",
              body: "Hi {{1}}, please confirm your cash-on-delivery order {{2}} for {{3}} from {{4}}. We'll only ship once you confirm.",
              examples: ["Priya", "#1024", "INR 1499", "Kurta House"],
            },
            {
              name: "cod_reminder",
              body: "Hi {{1}}, we still need you to confirm order {{2}} before we can ship it.",
              examples: ["Priya", "#1024"],
            },
          ];

          const created: string[] = [];
          const failures: string[] = [];

          for (const spec of specs) {
            const components: AnyRecord[] = [
              {
                type: "BODY",
                text: spec.body,
                example: { body_text: [spec.examples] },
              },
              buttons,
            ];

            const result = await graphFetch(
              `${connection.wabaId}/message_templates`,
              connection.accessToken,
              {
                method: "POST",
                body: { name: spec.name, language, category: "UTILITY", components },
              },
            );

            // Already submitted earlier is not an error worth surfacing — the
            // sync below picks the existing one up.
            if (!result.ok) {
              failures.push(`${spec.name}: ${graphErrorMessage(result.body)}`);
              continue;
            }

            const status = String(result.body["status"] ?? "PENDING").toUpperCase();
            await supabase.from("message_templates").upsert(
              {
                organization_id: organizationId,
                waba_id: connection.wabaId,
                meta_template_id: (result.body["id"] as string) ?? null,
                name: spec.name,
                language,
                category: "UTILITY",
                status: ["PENDING", "APPROVED", "REJECTED", "PAUSED"].includes(status)
                  ? status
                  : "PENDING",
                components,
                rejection_reason: null,
                updated_at: nowIso,
              },
              { onConflict: "organization_id,waba_id,name,language" },
            );
            created.push(spec.name);
          }

          if (created.length === 0) {
            return Response.json(
              { error: failures[0] ?? "We couldn't submit these messages." },
              { status: 400 },
            );
          }

          await logServerActivity(supabase, organizationId, userId, "template_created", {
            template_names: created,
            category: "UTILITY",
            purpose: "cod_confirmation",
            whatsapp_account_id: connection.accountId,
          });

          return Response.json({ created, failures });
        }

        // ---- the three retention messages (winback, reorder, review) ----
        if (action === "create_retention_templates") {
          const { connection, error: connectionError } = await getWhatsAppConnection(
            supabase,
            organizationId,
            requestedAccountId,
          );
          if (!connection) return jsonError(connectionError ?? "No connected number.", 400);

          const language = String(payload["language"] ?? "en");
          // Every link goes through our own short-link redirect, so clicks are
          // counted and the destination can differ per customer.
          const linkButton = (text: string) => ({
            type: "BUTTONS",
            buttons: [
              {
                type: "URL",
                text,
                url: "https://aidwar.in/r/{{1}}",
                example: ["https://aidwar.in/r/ab12cd34ef"],
              },
            ],
          });

          const specs = [
            {
              name: "winback_offer",
              body: "Hi {{1}}, it's been a while since your last order from {{2}}. Here's what's new.",
              examples: ["Priya", "Kurta House"],
              button: "See what's new",
            },
            {
              name: "reorder_reminder",
              body: "Hi {{1}}, running low? You ordered {{2}} from {{3}} a while back — reorder in one tap.",
              examples: ["Priya", "Cotton Kurta", "Kurta House"],
              button: "Reorder",
            },
            {
              name: "review_request",
              body: "Hi {{1}}, how was your order {{2}}? Your review helps other shoppers.",
              examples: ["Priya", "#1024"],
              button: "Leave a review",
            },
          ];

          const created: string[] = [];
          const failures: string[] = [];

          for (const spec of specs) {
            const components: AnyRecord[] = [
              { type: "BODY", text: spec.body, example: { body_text: [spec.examples] } },
              linkButton(spec.button),
            ];

            const result = await graphFetch(
              `${connection.wabaId}/message_templates`,
              connection.accessToken,
              {
                method: "POST",
                body: { name: spec.name, language, category: "MARKETING", components },
              },
            );
            if (!result.ok) {
              failures.push(`${spec.name}: ${graphErrorMessage(result.body)}`);
              continue;
            }

            const status = String(result.body["status"] ?? "PENDING").toUpperCase();
            await supabase.from("message_templates").upsert(
              {
                organization_id: organizationId,
                waba_id: connection.wabaId,
                meta_template_id: (result.body["id"] as string) ?? null,
                name: spec.name,
                language,
                category: "MARKETING",
                status: ["PENDING", "APPROVED", "REJECTED", "PAUSED"].includes(status)
                  ? status
                  : "PENDING",
                components,
                rejection_reason: null,
                updated_at: nowIso,
              },
              { onConflict: "organization_id,waba_id,name,language" },
            );
            created.push(spec.name);
          }

          if (created.length === 0) {
            return Response.json(
              { error: failures[0] ?? "We couldn't submit these messages." },
              { status: 400 },
            );
          }

          await logServerActivity(supabase, organizationId, userId, "template_created", {
            template_names: created,
            category: "MARKETING",
            purpose: "retention_flows",
            whatsapp_account_id: connection.accountId,
          });

          return Response.json({ created, failures });
        }

        return jsonError("Unsupported action.");
      },
    },
  },
});
