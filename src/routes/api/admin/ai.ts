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
            .select("key, name, description, content, default_content, version, updated_at")
            .order("key");
          if (error) return jsonError("The platform rules could not be loaded.", 500);
          return Response.json({ blocks: data ?? [] });
        }

        if (action === "save_prompt_block") {
          const key = String(payload["key"] ?? "").trim();
          const content = String(payload["content"] ?? "").trim();
          if (!key) return jsonError("Which block?");
          if (content.length < 10) return jsonError("The rules cannot be empty.");
          if (content.length > 20000) return jsonError("That is too long to send with every message.");
          const { data: existing } = await supabase
            .from("ai_prompt_blocks")
            .select("version")
            .eq("key", key)
            .maybeSingle();
          if (!existing) return jsonError("That block does not exist.");
          const { error } = await supabase
            .from("ai_prompt_blocks")
            .update({
              content,
              version: Number((existing as { version?: number }).version ?? 1) + 1,
              updated_by: user.id,
            })
            .eq("key", key);
          if (error) return jsonError("The rules could not be saved.", 500);
          return Response.json({ ok: true });
        }

        if (action === "reset_prompt_block") {
          const key = String(payload["key"] ?? "").trim();
          const { data: existing } = await supabase
            .from("ai_prompt_blocks")
            .select("version, default_content")
            .eq("key", key)
            .maybeSingle();
          if (!existing) return jsonError("That block does not exist.");
          const row = existing as { version?: number; default_content?: string };
          const { error } = await supabase
            .from("ai_prompt_blocks")
            .update({
              content: row.default_content ?? "",
              version: Number(row.version ?? 1) + 1,
              updated_by: user.id,
            })
            .eq("key", key);
          if (error) return jsonError("The rules could not be reset.", 500);
          return Response.json({ ok: true });
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