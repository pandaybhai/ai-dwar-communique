import { createFileRoute } from "@tanstack/react-router";

/**
 * Everything the /app/employee screen reads and writes, except running the AI
 * itself (that is /api/internal/ai-run).
 */
export const Route = createFileRoute("/api/ai/employee")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireOrgMember, requirePermission, isResponse, jsonError, logServerActivity, isSuperAdmin } =
          await import("@/lib/whatsapp-api.server");

        let payload: Record<string, unknown>;
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          return jsonError("Invalid request.");
        }

        const auth = await requireOrgMember(request, (payload["organization_id"] as string) ?? null);
        if (isResponse(auth)) return auth;
        const canUse = await requirePermission(auth, "ai.use", "see the AI employee");
        if (canUse) return canUse;

        const action = String(payload["action"] ?? "overview");
        const supabase = auth.supabase;
        const org = auth.organizationId;

        const needsConfigure = [
          "set_mode",
          "save_settings",
          "save_instructions",
          "set_tier",
          "revert_instructions",
          "save_skill",
          "add_skill",
          "delete_skill",
        ].includes(action);

        if (needsConfigure) {
          const denied = await requirePermission(auth, "ai.configure", "change the AI employee");
          if (denied) return denied;
        }

        const agentRow = async () => {
          const { data } = await supabase
            .from("ai_agents")
            .select("id, name, avatar, mode")
            .eq("organization_id", org)
            .eq("is_default", true)
            .maybeSingle();
          return data as { id: string; name: string; avatar: string | null; mode: string } | null;
        };

        try {
          if (action === "overview") {
            const agent = await agentRow();
            const [
              settings,
              models,
              taskModels,
              instructions,
              sources,
              weekRuns,
              spend,
              lastTest,
            ] = await Promise.all([
              supabase
                .from("organization_ai_settings")
                .select("ai_enabled, ai_monthly_cap_amount, currency, brain_choice")
                .eq("organization_id", org)
                .maybeSingle(),
              // Tiers, not vendors: the merchant never sees who or what runs it.
              supabase
                .from("ai_tiers")
                .select(
                  "key, display_name, plain_description, speed_text, quality_text, relative_cost_text",
                )
                .eq("is_active", true)
                .order("sort_order"),
              supabase
                .from("ai_task_models")
                .select("task, tier, agent_id")
                .eq("organization_id", org),
              supabase
                .from("ai_instructions")
                .select(
                  "id, persona_name, tone, instructions, escalation_rules, handover_message, languages, working_hours_behaviour, version, is_current, updated_at",
                )
                .eq("organization_id", org)
                .order("version", { ascending: false })
                .limit(20),
              supabase
                .from("knowledge_sources")
                .select("id, type, name, status, item_count, last_synced_at, last_error")
                .eq("organization_id", org)
                .order("created_at", { ascending: false }),
              supabase
                .from("ai_runs")
                .select("status, escalation_signal, task, billed_amount, cost_source, created_at")
                .eq("organization_id", org)
                .gte("created_at", new Date(Date.now() - 7 * 864e5).toISOString()),
              supabase.rpc("ai_month_spend", { p_org: org }),
              supabase
                .from("ai_runs")
                .select("created_at")
                .eq("organization_id", org)
                .eq("task", "agent_reply")
                .is("conversation_id", null)
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle(),
            ]);

            // What the AI actually has in live customer conversations —
            // its own principal, not the admin looking at this page.
            const { brokerTools, agentPrincipal, agentSettings } = await import(
              "@/lib/ai-tools.server"
            );
            const { allAiTools } = await import("@/lib/feature-registry");
            const [available, agentConfig] = await Promise.all([
              brokerTools(supabase, org, agentPrincipal),
              agentSettings(supabase, org),
            ]);
            const availableNames = new Set(available.map((t) => t.name));
            const tools = allAiTools().map((t) => ({
              name: t.name,
              description: t.description,
              access: t.access,
              feature: t.feature,
              available: availableNames.has(t.name),
              reason: availableNames.has(t.name)
                ? null
                : t.access === "write" && !agentConfig.canWrite
                  ? "Switched off: the AI can only look things up, never change them, until you allow it."
                  : `Needs the ${t.feature} feature switched on and the "${t.required_permission}" permission on the AI's role.`,
            }));


            const runs = (weekRuns.data ?? []) as Array<{
              status: string;
              escalation_signal: string | null;
              task: string;
              billed_amount: number | null;
              cost_source: string | null;
            }>;

            const lastTestAt = (lastTest.data as { created_at?: string } | null)?.created_at ?? null;
            const testedRecently = lastTestAt
              ? Date.now() - new Date(lastTestAt).getTime() < 7 * 864e5
              : false;

            // Platform truth, Super Admin only: which vendor and model actually
            // sit behind each merchant-facing tier, and how the call is routed.
            const superAdmin = await isSuperAdmin(supabase, auth.userId);
            let tierInternals: Array<Record<string, unknown>> | null = null;
            if (superAdmin) {
              const { providerRoute } = await import("@/lib/ai-run.server");
              const { data: internals } = await supabase
                .from("ai_tiers")
                .select("key, provider, model_id")
                .order("sort_order");
              tierInternals = ((internals ?? []) as Array<{
                key: string;
                provider: string;
                model_id: string;
              }>).map((row) => ({
                key: row.key,
                provider: row.provider,
                model_id: row.model_id,
                route: providerRoute(row.provider),
              }));
            }

            return Response.json({
              agent,
              is_super_admin: superAdmin,
              tier_internals: tierInternals,
              settings: settings.data ?? null,
              spend_this_month: Number(spend.data ?? 0),
              tiers: models.data ?? [],
              task_models: taskModels.data ?? [],
              instructions: instructions.data ?? [],
              sources: sources.data ?? [],
              tools,
              week: {
                answered: runs.filter((r) => r.status === "ok").length,
                passed: runs.filter((r) => r.status === "escalated").length,
                refused: runs.filter((r) => r.status === "refused").length,
              },
              tested_recently: testedRecently,
              can_configure: await (async () => {
                const denied = await requirePermission(auth, "ai.configure");
                return denied === null;
              })(),
            });
          }

          if (action === "work") {
            const days = Math.min(Math.max(Number(payload["days"] ?? 30), 1), 180);
            const since = new Date(Date.now() - days * 864e5).toISOString();
            const { data } = await supabase
              .from("ai_runs")
              .select(
                "id, task, tier, provider, model, status, escalation_signal, billed_amount, cost_source, latency_ms, input_summary, output, sources, created_at",
              )
              .eq("organization_id", org)
              .gte("created_at", since)
              .order("created_at", { ascending: false })
              .limit(500);
            const runs = (data ?? []) as Array<Record<string, unknown>>;
            // The tool trace: which tool ran, whether it worked, and why not.
            const { data: traces } = await supabase
              .from("ai_tool_calls")
              .select("run_id, tool_name, ok, error, latency_ms")
              .eq("organization_id", org)
              .in("run_id", runs.map((r) => r["id"] as string).slice(0, 500));
            const byRun = new Map<string, Array<Record<string, unknown>>>();
            for (const t of (traces ?? []) as Array<Record<string, unknown>>) {
              const key = String(t["run_id"]);
              byRun.set(key, [...(byRun.get(key) ?? []), t]);
            }
            // The vendor and model behind a past run are platform-internal:
            // only a Super Admin ever receives them.
            const superAdmin = await isSuperAdmin(supabase, auth.userId);
            const { providerRoute } = await import("@/lib/ai-run.server");
            return Response.json({
              is_super_admin: superAdmin,
              runs: runs.map((r) => {
                const { provider, model, ...rest } = r as Record<string, unknown>;
                return {
                  ...rest,
                  ...(superAdmin
                    ? {
                        provider,
                        model,
                        route: providerRoute(String(provider ?? "")),
                      }
                    : {}),
                  tool_calls: byRun.get(String(r["id"])) ?? [],
                };
              }),
            });
          }

          if (action === "weekly_report") {
            // The employee's own account of its week, written from run data.
            const since = new Date(Date.now() - 7 * 864e5).toISOString();
            const { data } = await supabase
              .from("ai_runs")
              .select("status, escalation_signal, billed_amount, cost_source, input_summary, created_at")
              .eq("organization_id", org)
              .gte("created_at", since)
              .order("created_at", { ascending: false })
              .limit(2000);
            const rows = (data ?? []) as Array<{
              status: string;
              escalation_signal: string | null;
              billed_amount: number | null;
              cost_source: string | null;
              input_summary: string | null;
              created_at: string;
            }>;

            const answered = rows.filter((r) => r.status === "ok").length;
            const passed = rows.filter((r) => r.status === "escalated").length;
            // What the merchant pays, never what the provider charged us.
            const cost = rows.reduce(
              (sum, r) => sum + (r.cost_source === "unknown" ? 0 : Number(r.billed_amount ?? 0)),
              0,
            );

            // Only genuine knowledge gaps: no greetings, nothing another part
            // of the system handled, nothing it answered elsewhere this week.
            const { genuineGaps } = await import("@/lib/weekly-gaps");

            const answeredQuestions = rows
              .filter((r) => r.status === "ok")
              .map((r) => r.input_summary ?? "");

            let handledElsewhere: string[] = [];
            try {
              const { data: runsData } = await supabase
                .from("automation_runs")
                .select("inbound_message_id, status, created_at, automations!inner(organization_id)")
                .eq("automations.organization_id", org)
                .eq("status", "sent")
                .gte("created_at", since)
                .limit(500);
              const ids = ((runsData ?? []) as Array<{ inbound_message_id: string | null }>)
                .map((r) => r.inbound_message_id)
                .filter((id): id is string => Boolean(id));
              if (ids.length) {
                const { data: msgs } = await supabase
                  .from("messages")
                  .select("body")
                  .in("id", ids)
                  .limit(500);
                handledElsewhere = ((msgs ?? []) as Array<{ body: string | null }>).map(
                  (m) => m.body ?? "",
                );
              }
            } catch {
              handledElsewhere = [];
            }

            const learn = genuineGaps(rows, { answeredQuestions, handledElsewhere });

            return Response.json({
              report: { since, answered, passed, cost, learn },
            });

          }

          if (action === "questions") {
            const { recentCustomerQuestions } = await import("@/lib/ai-comparison.server");
            const questions = await recentCustomerQuestions(supabase, org, 20);
            return Response.json({ questions });
          }

          if (action === "set_mode") {
            const agent = await agentRow();
            if (!agent) return jsonError("No AI employee in this workspace yet.");
            const mode = String(payload["mode"] ?? "off");
            if (!["off", "draft", "replying"].includes(mode)) return jsonError("Unknown mode.");

            if (mode === "replying" && payload["skip_test"] !== true) {
              const { data: tested } = await supabase
                .from("ai_runs")
                .select("id")
                .eq("organization_id", org)
                .eq("task", "agent_reply")
                .is("conversation_id", null)
                .gte("created_at", new Date(Date.now() - 7 * 864e5).toISOString())
                .limit(1);
              if (!tested || tested.length === 0) {
                return Response.json(
                  {
                    needs_test: true,
                    message:
                      "You haven't tested this yet. Want to see how it would have answered your last 20 customer questions first?",
                  },
                  { status: 409 },
                );
              }
            }

            await supabase.from("ai_agents").update({ mode }).eq("id", agent.id);
            await logServerActivity(supabase, org, auth.userId, "ai_mode_changed", { mode });
            return Response.json({ ok: true, mode });
          }

          if (action === "save_settings") {
            const update: Record<string, unknown> = {};
            if (typeof payload["ai_enabled"] === "boolean") update["ai_enabled"] = payload["ai_enabled"];
            if (payload["ai_monthly_cap_amount"] !== undefined) {
              const cap = Number(payload["ai_monthly_cap_amount"]);
              // Zero used to mean "no limit". A missing limit now stops runs,
              // so the only sensible value is a real one.
              if (!Number.isFinite(cap) || cap <= 0)
                return jsonError("Enter a spending limit above zero — there's no unlimited option.");
              update["ai_monthly_cap_amount"] = cap;
            }
            if (payload["brain_choice"] === "recommended" || payload["brain_choice"] === "manual") {
              update["brain_choice"] = payload["brain_choice"];
            }
            if (typeof payload["name"] === "string") {
              const agent = await agentRow();
              if (agent) await supabase.from("ai_agents").update({ name: payload["name"] }).eq("id", agent.id);
            }
            if (Object.keys(update).length > 0) {
              await supabase.from("organization_ai_settings").upsert(
                { organization_id: org, ...update },
                { onConflict: "organization_id" },
              );
            }
            await logServerActivity(supabase, org, auth.userId, "ai_settings_updated", {
              fields: Object.keys(update),
            });
            return Response.json({ ok: true });
          }

          if (action === "clear_tier") {
            // Back to my recommendation for ONE job only — never resets the others.
            const task = String(payload["task"] ?? "");
            if (!task) return jsonError("Pick a job first.");
            const { error } = await supabase
              .from("ai_task_models")
              .delete()
              .eq("organization_id", org)
              .eq("task", task)
              .is("agent_id", null);
            if (error) return jsonError(error.message.replace(/^.*ERROR:\s*/, ""), 400);
            const { count } = await supabase
              .from("ai_task_models")
              .select("id", { count: "exact", head: true })
              .eq("organization_id", org)
              .is("agent_id", null);
            await supabase.from("organization_ai_settings").upsert(
              { organization_id: org, brain_choice: (count ?? 0) > 0 ? "manual" : "recommended" },
              { onConflict: "organization_id" },
            );
            await logServerActivity(supabase, org, auth.userId, "ai_tier_changed", {
              task,
              tier: "recommended",
            });
            return Response.json({ ok: true });
          }

          if (action === "set_tier") {
            const task = String(payload["task"] ?? "");
            const tier = String(payload["tier"] ?? "");
            if (!task || !tier) return jsonError("Pick a job and how careful I should be.");
            const { data: existing } = await supabase
              .from("ai_task_models")
              .select("id")
              .eq("organization_id", org)
              .eq("task", task)
              .is("agent_id", null)
              .maybeSingle();
            const row = existing as { id: string } | null;
            const { error } = row
              ? await supabase.from("ai_task_models").update({ tier }).eq("id", row.id)
              : await supabase.from("ai_task_models").insert({ organization_id: org, task, tier });
            if (error) return jsonError(error.message.replace(/^.*ERROR:\s*/, ""), 400);
            await supabase
              .from("organization_ai_settings")
              .upsert({ organization_id: org, brain_choice: "manual" }, { onConflict: "organization_id" });
            await logServerActivity(supabase, org, auth.userId, "ai_tier_changed", { task, tier });
            return Response.json({ ok: true });
          }

          if (action === "save_instructions") {
            const agent = await agentRow();
            if (!agent) return jsonError("No AI employee in this workspace yet.");
            const { data: current } = await supabase
              .from("ai_instructions")
              .select("version")
              .eq("agent_id", agent.id)
              .order("version", { ascending: false })
              .limit(1)
              .maybeSingle();
            const nextVersion = Number((current as { version?: number } | null)?.version ?? 0) + 1;

            await supabase.from("ai_instructions").update({ is_current: false }).eq("agent_id", agent.id);
            const { error } = await supabase.from("ai_instructions").insert({
              organization_id: org,
              agent_id: agent.id,
              persona_name: String(payload["persona_name"] ?? agent.name),
              tone: String(payload["tone"] ?? "friendly"),
              instructions: String(payload["instructions"] ?? ""),
              escalation_rules: String(payload["escalation_rules"] ?? ""),
              handover_message:
                String(payload["handover_message"] ?? "").trim() ||
                "Let me get someone from the team to help — they'll reply here shortly.",
              languages:
                Array.isArray(payload["languages"]) && payload["languages"].length
                  ? (payload["languages"] as unknown[]).map(String)
                  : ["en", "hi"],

              working_hours_behaviour: String(payload["working_hours_behaviour"] ?? "always"),
              version: nextVersion,
              is_current: true,
              updated_by: auth.userId,
            });
            if (error) return jsonError("We couldn't save that.");
            await logServerActivity(supabase, org, auth.userId, "ai_instructions_updated", {
              version: nextVersion,
            });
            return Response.json({ ok: true, version: nextVersion });
          }

          if (action === "revert_instructions") {
            const agent = await agentRow();
            const versionId = String(payload["instruction_id"] ?? "");
            if (!agent || !versionId) return jsonError("Which version?");
            const { data: old } = await supabase
              .from("ai_instructions")
              .select("*")
              .eq("id", versionId)
              .eq("organization_id", org)
              .maybeSingle();
            if (!old) return jsonError("That version is gone.");
            const source = old as Record<string, unknown>;
            const { data: current } = await supabase
              .from("ai_instructions")
              .select("version")
              .eq("agent_id", agent.id)
              .order("version", { ascending: false })
              .limit(1)
              .maybeSingle();
            const nextVersion = Number((current as { version?: number } | null)?.version ?? 0) + 1;
            await supabase.from("ai_instructions").update({ is_current: false }).eq("agent_id", agent.id);
            await supabase.from("ai_instructions").insert({
              organization_id: org,
              agent_id: agent.id,
              persona_name: source["persona_name"],
              tone: source["tone"],
              instructions: source["instructions"],
              escalation_rules: source["escalation_rules"],
              handover_message: source["handover_message"],
              languages: source["languages"],
              working_hours_behaviour: source["working_hours_behaviour"],
              version: nextVersion,
              is_current: true,
              updated_by: auth.userId,
            });
            return Response.json({ ok: true, version: nextVersion });
          }

          if (action === "skills") {
            const { listSkills } = await import("@/lib/ai-skills.server");
            const skills = await listSkills(supabase, org);
            return Response.json({ skills });
          }

          if (action === "save_skill") {
            const id = String(payload["skill_id"] ?? "");
            if (!id) return jsonError("Which job?");
            const update: Record<string, unknown> = {};
            if (typeof payload["enabled"] === "boolean") update["enabled"] = payload["enabled"];
            if (typeof payload["use_when"] === "string") update["use_when"] = payload["use_when"].slice(0, 600);
            if (typeof payload["do_not_use_when"] === "string")
              update["do_not_use_when"] = payload["do_not_use_when"].slice(0, 600);
            if (typeof payload["name"] === "string" && payload["name"].trim())
              update["name"] = payload["name"].trim().slice(0, 80);
            if (!Object.keys(update).length) return jsonError("Nothing to change.");
            const { error } = await supabase
              .from("ai_skills")
              .update(update)
              .eq("id", id)
              .eq("organization_id", org);
            if (error) return jsonError(error.message.replace(/^.*ERROR:\s*/, ""), 400);
            await logServerActivity(supabase, org, auth.userId, "ai_skill_updated", {
              skill_id: id,
              fields: Object.keys(update),
            });
            return Response.json({ ok: true });
          }

          if (action === "add_skill") {
            const name = String(payload["name"] ?? "").trim();
            if (!name) return jsonError("Give this job a name.");
            const key = `custom_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40)}_${Date.now()
              .toString(36)
              .slice(-4)}`;
            const { error } = await supabase.from("ai_skills").insert({
              organization_id: org,
              key,
              name: name.slice(0, 80),
              use_when: String(payload["use_when"] ?? "").slice(0, 600),
              do_not_use_when: String(payload["do_not_use_when"] ?? "").slice(0, 600),
              is_custom: true,
              sort_order: 200,
            });
            if (error) return jsonError(error.message.replace(/^.*ERROR:\s*/, ""), 400);
            await logServerActivity(supabase, org, auth.userId, "ai_skill_added", { key });
            return Response.json({ ok: true });
          }

          if (action === "delete_skill") {
            const id = String(payload["skill_id"] ?? "");
            if (!id) return jsonError("Which job?");
            const { error } = await supabase
              .from("ai_skills")
              .delete()
              .eq("id", id)
              .eq("organization_id", org)
              .eq("is_custom", true);
            if (error) return jsonError(error.message.replace(/^.*ERROR:\s*/, ""), 400);
            await logServerActivity(supabase, org, auth.userId, "ai_skill_removed", { skill_id: id });
            return Response.json({ ok: true });
          }

          if (action === "brief") {
            const agent = await agentRow();
            const { assembleBrief, estimateBriefCost } = await import("@/lib/ai-brief.server");
            const brief = await assembleBrief(supabase, org, agent?.id ?? null);
            const cost = await estimateBriefCost(supabase, org, agent?.id ?? null, brief.characters);
            const superAdmin = await isSuperAdmin(supabase, auth.userId);
            return Response.json({
              sections: brief.sections.map((s) => ({
                ...s,
                ...(s.key === "rules" ? { editable_by_super_admin: superAdmin } : {}),
              })),
              characters: brief.characters,
              rules_version: brief.rulesVersion,
              rules_from_database: brief.rulesFromDatabase,
              taught_count: brief.taughtCount,
              estimated_cost: cost.amount,
              estimated_currency: cost.currency,
              estimated_tokens: cost.tokens,
              is_super_admin: superAdmin,
            });
          }

          return jsonError("Unknown action.");

        } catch (error) {
          const message = error instanceof Error ? error.message : "That didn't work.";
          console.error("[ai-employee] failed", action, message);
          return Response.json({ error: message }, { status: 500 });
        }
      },
    },
  },
});
