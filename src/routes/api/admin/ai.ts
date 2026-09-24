import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/admin/ai")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const { isSuperAdmin, jsonError } = await import("@/lib/whatsapp-api.server");
        const header = request.headers.get("authorization") ?? "";
        const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
        if (!token) return jsonError("Not authenticated.", 401);

        const supabase = getServiceClient();
        const { data: userData } = await supabase.auth.getUser(token);
        const user = userData.user;
        if (!user) return jsonError("Not authenticated.", 401);
        if (!(await isSuperAdmin(supabase, user.id))) return jsonError("Super Admin access required.", 403);

        let payload: Record<string, unknown>;
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          return jsonError("Invalid request.");
        }
        const action = String(payload["action"] ?? "overview");

        // ---- Aiden control centre: behaviour for any workspace (one shared save path).
        if (action === "aiden_orgs") {
          const q = String(payload["q"] ?? "").trim();
          let query = supabase.from("organizations").select("id, name").order("name").limit(50);
          if (q) query = query.ilike("name", `%${q.replace(/[%_]/g, "")}%`);
          const { data } = await query;
          return Response.json({ organizations: data ?? [] });
        }

        if (
          action === "behaviour_load" ||
          action === "save_instructions" ||
          action === "revert_instructions"
        ) {
          const orgId = String(payload["organization_id"] ?? "");
          if (!/^[0-9a-f-]{36}$/i.test(orgId)) return jsonError("Pick a workspace.");
          const { data: agentData } = await supabase
            .from("ai_agents")
            .select("id, name")
            .eq("organization_id", orgId)
            .eq("is_default", true)
            .maybeSingle();
          const agent = agentData as { id: string; name: string } | null;
          const behaviour = await import("@/lib/behaviour-save.server");

          if (action === "behaviour_load") {
            if (!agent) return Response.json({ agent: null, instructions: [] });
            const { data: rows } = await supabase
              .from("ai_instructions")
              .select(
                "id, persona_name, tone, instructions, escalation_rules, handover_message, languages, working_hours_behaviour, version, is_current, updated_at, updated_by",
              )
              .eq("agent_id", agent.id)
              .order("version", { ascending: false })
              .limit(20);
            const list = (rows ?? []) as Array<Record<string, unknown>>;
            const names = await behaviour.authorNames(list.map((r) => String(r["updated_by"] ?? "")), "admin");
            return Response.json({
              agent,
              instructions: list.map((r) => {
                const n = names[String(r["updated_by"] ?? "")];
                return { ...r, updated_by_name: n ? (n.is_support ? `${n.name} (AiDwar)` : n.name) : null };
              }),
            });
          }

          if (!agent) return jsonError("This workspace has no AI employee yet.");
          let fields = behaviour.fieldsFromPayload(payload, agent.name);
          let revertedFrom: number | undefined;
          if (action === "revert_instructions") {
            const { data: old } = await supabase
              .from("ai_instructions")
              .select("*")
              .eq("id", String(payload["instruction_id"] ?? ""))
              .eq("organization_id", orgId)
              .maybeSingle();
            if (!old) return jsonError("That version is gone.");
            fields = behaviour.fieldsFromPayload(old as Record<string, unknown>, agent.name);
            revertedFrom = Number((old as { version?: number }).version ?? 0);
          }
          const base = payload["base_version"];
          const result = await behaviour.saveBehaviourVersion(supabase, {
            organizationId: orgId,
            agentId: agent.id,
            userId: user.id,
            fields,
            baseVersion: typeof base === "number" ? base : null,
            audience: "admin",
            via: "super_admin",
            ...(revertedFrom != null ? { reverted_from: revertedFrom } : {}),
          });
          if (!result.ok && "conflict" in result)
            return Response.json(
              { error: behaviour.conflictMessage(result.conflict), conflict: result.conflict },
              { status: 409 },
            );
          if (!result.ok) return jsonError(result.error);
          return Response.json({ ok: true, version: result.version });
        }

        if (action === "overview") {
          const [settings, providers, tiers, models, rates, runs, platformSpend] = await Promise.all([
            supabase
              .from("platform_settings")
              .select("ai_markup_multiplier, ai_monthly_cap_amount, ai_cap_currency")
              .eq("id", true)
              .single(),
            // The status function answers "is a key actually stored?" by
            // query, checking the vault rather than trusting a name column.
            supabase.rpc("platform_ai_credential_status"),
            supabase
              .from("ai_tiers")
              .select("key, display_name, provider, model_id, is_active, sort_order")
              .order("sort_order"),
            supabase
              .from("ai_models")
              .select("provider, model_id, display_name, supports_tools, is_available, is_deprecated")
              .order("display_name"),
            supabase
              .from("ai_rates")
              .select("provider, model, input_rate, output_rate, currency, effective_from")
              .order("effective_from", { ascending: false }),
            supabase
              .from("ai_runs")
              .select("cost_amount, billed_amount, cost_source")
              .gte("created_at", new Date(Date.now() - 30 * 864e5).toISOString()),
            supabase.rpc("platform_ai_month_spend"),
          ]);
          const runRows = (runs.data ?? []) as Array<{
            cost_amount: number | null;
            billed_amount: number | null;
            cost_source: string | null;
          }>;
          const cost = runRows.reduce((sum, row) => sum + Number(row.cost_amount ?? 0), 0);
          const billed = runRows.reduce((sum, row) => sum + Number(row.billed_amount ?? 0), 0);
          return Response.json({
            markup: Number(settings.data?.ai_markup_multiplier ?? 3),
            // The ceiling on total billed spend across every organisation.
            platform_cap: {
              amount: Number(
                (settings.data as { ai_monthly_cap_amount?: number } | null)?.ai_monthly_cap_amount ?? 0,
              ),
              currency:
                (settings.data as { ai_cap_currency?: string } | null)?.ai_cap_currency ?? "INR",
              spent: Number((platformSpend.data as number | null) ?? 0),
            },
            providers: ((providers.data ?? []) as Array<{
              provider: string;
              is_active: boolean;
              key_present: boolean;
              key_set_at: string | null;
              last_error: string | null;
            }>).map((row) => ({
              provider: row.provider,
              is_active: row.is_active,
              has_key: row.key_present,
              key_set_at: row.key_set_at,
              last_error: row.last_error,
              updated_at: row.key_set_at,
            })),
            tiers: tiers.data ?? [],
            models: models.data ?? [],
            rates: rates.data ?? [],
            totals: { cost, billed, margin: billed - cost, runs: runRows.length },
          });
        }

        // The platform-wide rules every employee is briefed with. Merchants
        // read these in the prompt preview; only a Super Admin rewrites them.
        if (action === "prompt_blocks") {
          const { data, error } = await supabase
            .from("ai_prompt_blocks")
            .select("key, name, description, content, default_content, version, updated_at, updated_by")
            .order("key");
          if (error) return jsonError("The platform rules could not be loaded.", 500);
          const rows = (data ?? []) as Array<Record<string, unknown>>;
          const { authorNames } = await import("@/lib/behaviour-save.server");
          const names = await authorNames(rows.map((r) => String(r["updated_by"] ?? "")), "admin");
          return Response.json({
            blocks: rows.map((r) => ({ ...r, updated_by_name: names[String(r["updated_by"] ?? "")]?.name ?? null })),
          });
        }

        if (action === "save_prompt_block" || action === "reset_prompt_block") {
          const key = String(payload["key"] ?? "").trim();
          if (!key) return jsonError("Which block?");
          const { data: existing } = await supabase
            .from("ai_prompt_blocks")
            .select("version, default_content, updated_by, updated_at")
            .eq("key", key)
            .maybeSingle();
          if (!existing) return jsonError("That block does not exist.");
          const row = existing as { version: number; default_content: string; updated_by: string | null; updated_at: string };
          const { authorNames, conflictMessage } = await import("@/lib/behaviour-save.server");
          const conflict = async () => {
            const { data: now } = await supabase
              .from("ai_prompt_blocks")
              .select("version, updated_by, updated_at")
              .eq("key", key)
              .maybeSingle();
            const cur = (now ?? row) as { version: number; updated_by: string | null; updated_at: string };
            const names = await authorNames(cur.updated_by ? [cur.updated_by] : [], "admin");
            const c = { by: (cur.updated_by && names[cur.updated_by]?.name) || "someone else", at: cur.updated_at, version: cur.version };
            return Response.json({ error: conflictMessage(c), conflict: c }, { status: 409 });
          };
          const base = typeof payload["base_version"] === "number" ? (payload["base_version"] as number) : row.version;
          if (base !== row.version) return conflict();
          let content = row.default_content ?? "";
          if (action === "save_prompt_block") {
            content = String(payload["content"] ?? "").trim();
            if (content.length < 10) return jsonError("The rules cannot be empty.");
            if (content.length > 20000) return jsonError("That is too long to send with every message.");
          }
          const nextVersion = row.version + 1;
          // Guarded on the loaded version, so two admins saving at once can't both win.
          const { data: written, error } = await supabase
            .from("ai_prompt_blocks")
            .update({ content, version: nextVersion, updated_by: user.id })
            .eq("key", key)
            .eq("version", row.version)
            .select("key");
          if (error) return jsonError("The rules could not be saved.", 500);
          if (!written || written.length === 0) return conflict();
          const { resolvePlatformOrg } = await import("@/lib/billing-notify.server");
          const { logServerActivity } = await import("@/lib/whatsapp-api.server");
          const platformOrg = await resolvePlatformOrg(supabase).catch(() => null);
          if (platformOrg)
            await logServerActivity(supabase, platformOrg, user.id, "ai_prompt_block_updated", {
              key,
              old_version: row.version,
              version: nextVersion,
              reset: action === "reset_prompt_block",
            });
          return Response.json({ ok: true, version: nextVersion });
        }

        if (action === "set_markup") {
          const multiplier = Number(payload["multiplier"]);
          if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 100) {
            return jsonError("Enter a markup between 1 and 100.");
          }
          const { error } = await supabase
            .from("platform_settings")
            .update({ ai_markup_multiplier: multiplier, updated_at: new Date().toISOString() })
            .eq("id", true);
          if (error) return jsonError("The markup could not be saved.", 500);
          return Response.json({ ok: true });
        }

        if (action === "set_platform_cap") {
          const amount = Number(payload["amount"]);
          // Zero is not "unlimited" — a ceiling must be a real number.
          if (!Number.isFinite(amount) || amount <= 0) {
            return jsonError("Enter a monthly ceiling above zero. There is no unlimited setting.");
          }
          const { error } = await supabase
            .from("platform_settings")
            .update({ ai_monthly_cap_amount: amount, updated_at: new Date().toISOString() })
            .eq("id", true);
          if (error) return jsonError("The platform ceiling could not be saved.", 500);
          return Response.json({ ok: true });
        }

        if (action === "set_provider_key") {
          const provider = String(payload["provider"] ?? "");
          const key = String(payload["key"] ?? "").trim();
          if (!["anthropic", "openai", "google"].includes(provider) || key.length < 8) {
            return jsonError("Choose a provider and enter its key.");
          }
          const { error } = await supabase.rpc("platform_set_ai_key", {
            p_provider: provider,
            p_key: key,
          });
          if (error) return jsonError("The provider key could not be stored.", 500);
          return Response.json({ ok: true });
        }

        if (action === "set_provider_active") {
          const provider = String(payload["provider"] ?? "");
          const enabled = payload["enabled"] === true;
          if (!["anthropic", "openai", "google", "lovable"].includes(provider)) {
            return jsonError("Unknown provider.");
          }
          const { error } = await supabase
            .from("platform_ai_providers")
            .update({ is_active: enabled, updated_at: new Date().toISOString() })
            .eq("provider", provider);
          if (error) return jsonError("The provider could not be updated.", 500);
          return Response.json({ ok: true });
        }

        if (action === "set_tier_model") {
          const tier = String(payload["tier"] ?? "");
          const provider = String(payload["provider"] ?? "");
          const modelId = String(payload["model_id"] ?? "");
          const { data: model } = await supabase
            .from("ai_models")
            .select("provider, model_id, is_available, is_deprecated")
            .eq("provider", provider)
            .eq("model_id", modelId)
            .maybeSingle();
          if (!model || !model.is_available || model.is_deprecated) return jsonError("Choose an available model.");
          const { error } = await supabase
            .from("ai_tiers")
            .update({ provider, model_id: modelId, updated_at: new Date().toISOString() })
            .eq("key", tier);
          if (error) return jsonError("The tier mapping could not be saved.", 500);
          return Response.json({ ok: true });
        }

        return jsonError("Unknown action.");
      },
    },
  },
});