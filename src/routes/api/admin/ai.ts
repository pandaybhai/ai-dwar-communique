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

        // ---- Aiden control centre: Test tab. Customer-mode answer, never sent, never billed.
        if (action === "aiden_test") {
          const orgId = String(payload["organization_id"] ?? "");
          if (!/^[0-9a-f-]{36}$/i.test(orgId)) return jsonError("Pick a workspace.");
          const question = String(payload["question"] ?? "").trim().slice(0, 2000);
          if (!question) return jsonError("Type a customer message.");
          const rawHistory = Array.isArray(payload["history"]) ? (payload["history"] as Array<Record<string, unknown>>) : [];
          const history = rawHistory
            .filter((t) => (t["role"] === "user" || t["role"] === "assistant") && typeof t["content"] === "string")
            .map((t) => ({ role: t["role"] as "user" | "assistant", content: String(t["content"]).slice(0, 2000) }));
          const instructionsOverride = typeof payload["instructions_override"] === "string" && payload["instructions_override"].trim()
            ? String(payload["instructions_override"]).slice(0, 8000)
            : null;
          const { playgroundAnswer } = await import("@/lib/ai-tasks.server");
          const run = await playgroundAnswer(
            supabase,
            { organizationId: orgId, actorUserId: user.id, actingRole: "owner" },
            question,
            null,
            instructionsOverride,
            null,
            { history },
          );
          const { resolvePlatformOrg } = await import("@/lib/billing-notify.server");
          const { logServerActivity } = await import("@/lib/whatsapp-api.server");
          const platformOrg = await resolvePlatformOrg(supabase).catch(() => null);
          if (platformOrg)
            await logServerActivity(supabase, platformOrg, user.id, "aiden_admin_test", {
              organization_id: orgId,
              status: run.status,
              draft_behaviour: Boolean(instructionsOverride),
            }).catch(() => undefined);
          return Response.json({
            status: run.status,
            reply: run.output,
            error: run.error ?? null,
            needs_owner: run.needsOwner,
            escalation: run.escalationSignal,
            tools: run.toolCalls.map((t) => ({ tool: t.tool, ok: t.ok })),
            media: run.media.map((m) => ({ title: m.title, image_url: m.imageUrl, price: m.price, currency: m.currency })),
            tier: run.tier,
            latency_ms: run.latencyMs,
          });
        }

        // ---- Aiden control centre: behaviour for any workspace (one shared save path).
        if (action === "aiden_orgs") {
          const q = String(payload["q"] ?? "").trim();
          let query = supabase.from("organizations").select("id, name").order("name").limit(50);
          if (q) query = query.ilike("name", `%${q.replace(/[%_]/g, "")}%`);
          const { data } = await query;
          const orgs = (data ?? []) as Array<{ id: string; name: string }>;
          const ids = orgs.map((o) => o.id);
          if (!ids.length) return Response.json({ organizations: [], platform_credits: null });
          const month = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1))
            .toISOString()
            .slice(0, 10);
          const [tavilyAll, firecrawlAll] = await Promise.all([
            supabase.from("reader_usage").select("organization_id, credits").eq("engine", "tavily").eq("month", month),
            supabase.from("firecrawl_usage").select("credits").eq("month", month),
          ]);
          const tavilyRows = (tavilyAll.data ?? []) as Array<{ organization_id: string; credits: number }>;
          const platform_credits = {
            tavily: tavilyRows.reduce((n, r) => n + Number(r.credits ?? 0), 0),
            firecrawl: ((firecrawlAll.data ?? []) as Array<{ credits: number }>).reduce((n, r) => n + Number(r.credits ?? 0), 0),
          };
          const [plans, numbers, agents, instr, sources, credits, supers] = await Promise.all([
            supabase.from("organizations").select("id, plan_status").in("id", ids),
            supabase.from("whatsapp_accounts").select("organization_id").in("organization_id", ids).eq("status", "active"),
            supabase.from("ai_agents").select("organization_id, mode").in("organization_id", ids).eq("is_default", true),
            supabase.from("ai_instructions").select("organization_id, origin, updated_by").in("organization_id", ids).eq("is_current", true),
            supabase
              .from("knowledge_sources")
              .select("organization_id, type, item_count, pages_seen, last_synced_at, config")
              .in("organization_id", ids),
            supabase.from("firecrawl_usage").select("organization_id, credits").in("organization_id", ids).eq("month", month),
            supabase.from("profiles").select("id").eq("is_super_admin", true),
          ]);
          const superIds = new Set(((supers.data ?? []) as Array<{ id: string }>).map((r) => r.id));
          type Src = { organization_id: string; type: string; item_count: number | null; pages_seen: number | null; last_synced_at: string | null; config: Record<string, unknown> | null };
          const srcRows = (sources.data ?? []) as Src[];
          const rows = orgs.map((o) => {
            const cur = ((instr.data ?? []) as Array<{ organization_id: string; origin: string | null; updated_by: string | null }>).find(
              (r) => r.organization_id === o.id,
            );
            const behaviour = !cur || (!cur.updated_by && !cur.origin)
              ? "none"
              : cur.origin === "suggested"
                ? "suggested"
                : cur.origin === "admin" || (cur.updated_by && superIds.has(cur.updated_by))
                  ? "aidwar"
                  : "owner";
            const mine = srcRows.filter((r) => r.organization_id === o.id);
            const sites = mine.filter((r) => r.type === "website");
            const latest = (list: Src[]) =>
              list.map((r) => r.last_synced_at).filter(Boolean).sort().at(-1) ?? null;
            return {
              ...o,
              plan: ((plans.data ?? []) as Array<{ id: string; plan_status: string | null }>).find((r) => r.id === o.id)?.plan_status ?? null,
              numbers: ((numbers.data ?? []) as Array<{ organization_id: string }>).filter((r) => r.organization_id === o.id).length,
              ai_mode: ((agents.data ?? []) as Array<{ organization_id: string; mode: string }>).find((r) => r.organization_id === o.id)?.mode ?? null,
              behaviour,
              sources: mine.length,
              items: mine.reduce((n, r) => n + Number(r.item_count ?? 0), 0),
              pages_read: sites.reduce((n, r) => n + Number(r.pages_seen ?? 0), 0),
              tavily_credits_month: tavilyRows.filter((r) => r.organization_id === o.id).reduce((n, r) => n + Number(r.credits ?? 0), 0),
              credits_month: ((credits.data ?? []) as Array<{ organization_id: string; credits: number }>).find((r) => r.organization_id === o.id)?.credits ?? 0,
              last_full_read: latest(sites.filter((r) => r.config?.["mode"] === "full")),
              last_refresh: latest(sites),
            };
          });
          return Response.json({ organizations: rows, platform_credits });
        }

        if (
          action === "behaviour_load" ||
          action === "save_instructions" ||
          action === "revert_instructions" ||
          action === "generate_persona" ||
          action === "restore_previous"
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
                "id, persona_name, tone, instructions, escalation_rules, handover_message, languages, working_hours_behaviour, version, is_current, updated_at, updated_by, origin",
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
                const who = n ? (n.is_support ? `${n.name} (AiDwar)` : n.name) : null;
                return { ...r, updated_by_name: r["origin"] === "suggested" ? `Suggested from website${who ? ` by ${who}` : ""}` : who };
              }),
            });
          }

          if (!agent) return jsonError("This workspace has no AI employee yet.");
          let fields = behaviour.fieldsFromPayload(payload, agent.name);
          let revertedFrom: number | undefined;
          let origin: "admin" | "suggested" = "admin";
          if (action === "generate_persona") {
            const { generatePersona } = await import("@/lib/persona.server");
            const generated = await generatePersona(supabase, orgId, { agentId: agent.id, actorUserId: user.id });
            if (!generated.ok) return jsonError(generated.error);
            fields = generated.fields;
            origin = "suggested";
          }
          if (action === "revert_instructions" || action === "restore_previous") {
            let q = supabase.from("ai_instructions").select("*").eq("organization_id", orgId).eq("agent_id", agent.id);
            q =
              action === "restore_previous"
                ? q.eq("is_current", false).order("version", { ascending: false }).limit(1)
                : q.eq("id", String(payload["instruction_id"] ?? ""));
            const { data: old } = await q.maybeSingle();
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
            origin,
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
            const { isScriptKey, SCRIPTS, placeholdersIn } = await import("@/lib/scripts");
            if (isScriptKey(key)) {
              const allowed = SCRIPTS[key].vars;
              const unknown = placeholdersIn(content).filter((v) => !allowed.includes(v));
              if (unknown.length)
                return jsonError(
                  `{${unknown[0]}} can't be filled in here. Use only: ${allowed.length ? allowed.map((v) => `{${v}}`).join(", ") : "no placeholders"}.`,
                );
            }
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
          const { clearScriptCache } = await import("@/lib/scripts.server");
          clearScriptCache();
          return Response.json({ ok: true, version: nextVersion });
        }

        if (action === "reading_load" || action === "reading_save") {
          const { loadReadingSettings } = await import("@/lib/reading.server");
          const meta = async () => {
            const { data } = await supabase
              .from("platform_settings")
              .select("reading_version, reading_updated_at, reading_updated_by")
              .eq("id", true)
              .maybeSingle();
            const m = (data ?? {}) as { reading_version?: number; reading_updated_at?: string | null; reading_updated_by?: string | null };
            let by: string | null = null;
            if (m.reading_updated_by) {
              const { data: p } = await supabase.from("profiles").select("full_name, email").eq("id", m.reading_updated_by).maybeSingle();
              const pr = p as { full_name?: string | null; email?: string | null } | null;
              by = pr?.full_name || pr?.email || null;
            }
            return { version: m.reading_version ?? 1, updated_at: m.reading_updated_at ?? null, updated_by_name: by };
          };
          if (action === "reading_save") {
            const current = await meta();
            if (typeof payload["base_version"] === "number" && payload["base_version"] !== current.version)
              return Response.json(
                {
                  error: `Updated by ${current.updated_by_name ?? "another admin"} ${current.updated_at ? new Date(current.updated_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }) : ""} — reload to see their change`,
                  conflict: current,
                },
                { status: 409 },
              );
            const incoming = (payload["settings"] ?? {}) as Record<string, unknown>;
            const next: Record<string, unknown> = {};
            const ints = ["day0_page_limit", "backfill_pages_per_day", "refresh_days", "manual_refresh_cooldown_hours", "firecrawl_monthly_credit_cap", "firecrawl_workspace_monthly_cap", "tavily_monthly_credit_cap", "tavily_workspace_monthly_cap"];
            for (const k of ints) {
              if (incoming[k] == null) continue;
              const n = Math.floor(Number(incoming[k]));
              if (!Number.isFinite(n) || n < 0) return jsonError(`${k.replace(/_/g, " ")} must be 0 or more.`);
              next[k] = n;
            }
            if (next["day0_page_limit"] === 0) return jsonError("Quick read needs at least 1 page.");
            const ENGINES = ["own", "tavily", "firecrawl"];
            for (const k of ["reader_primary", "map_engine"]) {
              if (incoming[k] == null) continue;
              if (!ENGINES.includes(String(incoming[k]))) return jsonError("Unknown reading engine.");
              next[k] = incoming[k];
            }
            if (incoming["reader_fallback_order"] != null) {
              const list = Array.isArray(incoming["reader_fallback_order"]) ? incoming["reader_fallback_order"].map(String) : [];
              if (!list.length || list.some((e) => !ENGINES.includes(e))) return jsonError("Fallback order needs known engines.");
              next["reader_fallback_order"] = Array.from(new Set(list));
            }
            if (incoming["tavily_extract_depth"] != null) {
              if (!["basic", "advanced"].includes(String(incoming["tavily_extract_depth"]))) return jsonError("Unknown Tavily depth.");
              next["tavily_extract_depth"] = incoming["tavily_extract_depth"];
            }
            if (incoming["full_crawl_trigger"] != null) {
              if (!["on_number_connected", "on_plan_active", "manual"].includes(String(incoming["full_crawl_trigger"]))) return jsonError("Unknown full-read trigger.");
              next["full_crawl_trigger"] = incoming["full_crawl_trigger"];
            }
            if (incoming["on_demand_read"] != null) next["on_demand_read"] = Boolean(incoming["on_demand_read"]);
            if (incoming["plan_page_overrides"] != null) {
              const o: Record<string, number> = {};
              for (const [k, v] of Object.entries(incoming["plan_page_overrides"] as Record<string, unknown>)) {
                const n = Math.floor(Number(v));
                if (Number.isFinite(n) && n > 0) o[k] = n;
              }
              next["plan_page_overrides"] = o;
            }
            const before = await loadReadingSettings(supabase);
            const { data: updated, error: upErr } = await supabase
              .from("platform_settings")
              .update({ ...next, reading_version: current.version + 1, reading_updated_at: new Date().toISOString(), reading_updated_by: user.id })
              .eq("id", true)
              .eq("reading_version", current.version)
              .select("id");
            if (upErr) return jsonError("Couldn't save the reading settings.");
            if (!updated?.length) return jsonError("Someone saved at the same moment — reload to see their change.", 409);
            const changes: Record<string, { from: unknown; to: unknown }> = {};
            for (const [k, v] of Object.entries(next))
              if (JSON.stringify((before as Record<string, unknown>)[k]) !== JSON.stringify(v)) changes[k] = { from: (before as Record<string, unknown>)[k], to: v };
            const { resolvePlatformOrg } = await import("@/lib/billing-notify.server");
            const { logServerActivity } = await import("@/lib/whatsapp-api.server");
            const platformOrg = await resolvePlatformOrg(supabase).catch(() => null);
            if (platformOrg)
              await logServerActivity(supabase, platformOrg, user.id, "reading_settings_updated", {
                old_version: current.version,
                version: current.version + 1,
                changes,
              }).catch(() => undefined);
          }
          const [settings, m, plans] = await Promise.all([
            loadReadingSettings(supabase),
            meta(),
            supabase.from("plans").select("id, name, plan_versions!inner(limits, is_current)").eq("plan_versions.is_current", true),
          ]);
          return Response.json({
            settings,
            meta: m,
            plans: ((plans.data ?? []) as Array<{ id: string; name: string; plan_versions: Array<{ limits: Record<string, unknown> }> }>).map((p) => ({
              id: p.id,
              name: p.name,
              pages: Number(p.plan_versions[0]?.limits?.["pages"] ?? 0),
            })),
          });
        }

        if (action === "approved_templates") {
          const nudges = await import("@/lib/onboarding-nudges.server");
          const names = [nudges.CODE_TEMPLATE_NAME, nudges.RESUME_TEMPLATE_NAME];
          const { data } = await supabase
            .from("message_templates")
            .select("name, language, status")
            .in("name", names);
          const rows = (data ?? []) as Array<{ name: string; language: string; status: string }>;
          return Response.json({
            templates: [
              { name: nudges.CODE_TEMPLATE_NAME, body: nudges.CODE_TEMPLATE_BODY },
              { name: nudges.RESUME_TEMPLATE_NAME, body: nudges.RESUME_TEMPLATE_BODY },
            ].map((t) => ({ ...t, status: rows.find((r) => r.name === t.name)?.status ?? "unknown" })),
          });
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