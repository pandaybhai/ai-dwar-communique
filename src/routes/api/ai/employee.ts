import { createFileRoute } from "@tanstack/react-router";

/**
 * Everything the /app/employee screen reads and writes, except running the AI
 * itself (that is /api/internal/ai-run).
 */
export const Route = createFileRoute("/api/ai/employee")({
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
        const canUse = await requirePermission(auth, "ai.use", "see the AI employee");
        if (canUse) return canUse;

        const action = String(payload["action"] ?? "overview");
        const supabase = auth.supabase;
        const org = auth.organizationId;

        const needsConfigure = [
          "set_mode",
          "save_settings",
          "save_instructions",
          "set_brain",
          "revert_instructions",
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
              supabase
                .from("ai_models")
                .select("provider, model_id, display_name, plain_description, supports_tools, recommended_for")
                .eq("is_available", true)
                .eq("is_deprecated", false)
                .order("display_name"),
              supabase
                .from("ai_task_models")
                .select("task, provider, model_id, agent_id")
                .eq("organization_id", org),
              supabase
                .from("ai_instructions")
                .select(
                  "id, persona_name, tone, instructions, escalation_rules, languages, working_hours_behaviour, version, is_current, updated_at",
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
                .select("status, escalation_signal, task, cost_amount, cost_source, created_at")
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

            const { brokerTools } = await import("@/lib/ai-tools.server");
            const { allAiTools } = await import("@/lib/feature-registry");
            const available = await brokerTools(supabase, org, auth.userId);
            const availableNames = new Set(available.map((t) => t.name));
            const tools = allAiTools().map((t) => ({
              name: t.name,
              description: t.description,
              access: t.access,
              feature: t.feature,
              available: availableNames.has(t.name),
              reason: availableNames.has(t.name)
                ? null
                : `Needs the ${t.feature} feature switched on and the "${t.required_permission}" permission.`,
            }));

            const runs = (weekRuns.data ?? []) as Array<{
              status: string;
              escalation_signal: string | null;
              task: string;
              cost_amount: number | null;
              cost_source: string | null;
            }>;

            const lastTestAt = (lastTest.data as { created_at?: string } | null)?.created_at ?? null;
            const testedRecently = lastTestAt
              ? Date.now() - new Date(lastTestAt).getTime() < 7 * 864e5
              : false;

            return Response.json({
              agent,
              settings: settings.data ?? null,
              spend_this_month: Number(spend.data ?? 0),
              models: models.data ?? [],
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
                "id, task, status, escalation_signal, cost_amount, cost_source, latency_ms, input_summary, output, sources, created_at",
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
            return Response.json({
              runs: runs.map((r) => ({ ...r, tool_calls: byRun.get(String(r["id"])) ?? [] })),
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
              if (!Number.isFinite(cap) || cap < 0) return jsonError("Enter a spending limit of zero or more.");
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

          if (action === "set_brain") {
            const task = String(payload["task"] ?? "");
            const provider = String(payload["provider"] ?? "");
            const modelId = String(payload["model_id"] ?? "");
            if (!task || !provider || !modelId) return jsonError("Pick a job and a brain.");
            const { data: existing } = await supabase
              .from("ai_task_models")
              .select("id")
              .eq("organization_id", org)
              .eq("task", task)
              .is("agent_id", null)
              .maybeSingle();
            const row = existing as { id: string } | null;
            const { error } = row
              ? await supabase
                  .from("ai_task_models")
                  .update({ provider, model_id: modelId })
                  .eq("id", row.id)
              : await supabase
                  .from("ai_task_models")
                  .insert({ organization_id: org, task, provider, model_id: modelId });
            if (error) return jsonError(error.message.replace(/^.*ERROR:\s*/, ""), 400);
            await supabase
              .from("organization_ai_settings")
              .upsert({ organization_id: org, brain_choice: "manual" }, { onConflict: "organization_id" });
            await logServerActivity(supabase, org, auth.userId, "ai_brain_changed", { task });
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
              languages: Array.isArray(payload["languages"])
                ? (payload["languages"] as unknown[]).map(String)
                : ["en"],
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
              languages: source["languages"],
              working_hours_behaviour: source["working_hours_behaviour"],
              version: nextVersion,
              is_current: true,
              updated_by: auth.userId,
            });
            return Response.json({ ok: true, version: nextVersion });
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
