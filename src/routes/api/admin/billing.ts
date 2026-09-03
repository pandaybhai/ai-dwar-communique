import { createFileRoute } from "@tanstack/react-router";

/**
 * Every platform-owner billing action, behind one door. Super admin is checked
 * here and again inside each function — money surfaces never fail open.
 */
export const Route = createFileRoute("/api/admin/billing")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const { isSuperAdmin, jsonError } = await import("@/lib/whatsapp-api.server");
        const { billingError } = await import("@/lib/billing-route.server");

        const header = request.headers.get("authorization") ?? "";
        const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
        if (!token) return jsonError("Not authenticated.", 401);

        const supabase = getServiceClient();
        const { data: userData } = await supabase.auth.getUser(token);
        const user = userData.user;
        if (!user) return jsonError("Not authenticated.", 401);
        if (!(await isSuperAdmin(supabase, user.id))) {
          return jsonError("Super Admin access required.", 403);
        }

        let payload: Record<string, unknown>;
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          return jsonError("Invalid request.");
        }

        const action = String(payload["action"] ?? "overview");
        const orgId = (payload["organization_id"] as string | undefined) ?? "";
        const actorId = user.id;

        try {
          const admin = await import("@/lib/billing-admin.server");
          const core = await import("@/lib/billing.server");

          switch (action) {
            case "overview": {
              const data = await admin.adminOverview(supabase, actorId);
              return Response.json(data);
            }
            case "topup_tasks":
              return Response.json({ tasks: await admin.listTopupTasks(supabase, actorId) });

            case "complete_topup":
              return Response.json(
                await core.completeTopupTask(supabase, {
                  taskId: String(payload["task_id"]),
                  amount: Number(payload["amount"] ?? 0),
                  metaTxnRef: (payload["meta_txn_ref"] as string) || null,
                  actorId,
                }),
              );

            case "skip_topup":
              return Response.json(
                await admin.skipTopupTask(supabase, {
                  taskId: String(payload["task_id"]),
                  reason: String(payload["reason"] ?? ""),
                  actorId,
                }),
              );

            case "org": {
              if (!orgId) return jsonError("Which workspace?");
              const [detail, payments, accounts] = await Promise.all([
                core.adminOrgBilling(supabase, orgId, { userId: actorId }),
                admin.adminOrgPayments(supabase, orgId, actorId),
                admin.listBillingAccounts(supabase, actorId),
              ]);
              const { data: org } = await supabase
                .from("organizations")
                .select("id, name, funding_model, billing_day, billing_account_id, plan_status")
                .eq("id", orgId)
                .maybeSingle();
              const { data: account } = org?.billing_account_id
                ? await supabase
                    .from("billing_accounts")
                    .select("*")
                    .eq("id", org.billing_account_id as string)
                    .maybeSingle()
                : { data: null };
              const { data: bsp } = await supabase
                .from("bsp_accounts")
                .select("id, provider, currency, is_active")
                .eq("is_active", true);
              const { data: packs } = await supabase
                .from("credit_packs")
                .select("id, name, amount, bonus_amount")
                .eq("is_active", true)
                .order("sort_order");
              return Response.json({
                ...detail,
                organization: org ?? null,
                billing_account: account ?? null,
                billing_accounts: accounts,
                bsp_accounts: bsp ?? [],
                packs: packs ?? [],
                payments,
              });
            }

            case "assign_plan":
              return Response.json(
                await core.assignPlan(supabase, {
                  organizationId: orgId,
                  planKey: String(payload["plan_key"] ?? ""),
                  actorId,
                  status: (payload["status"] as string) || undefined,
                }),
              );

            case "recommend_plan":
              return Response.json(
                await core.recommendPlan(supabase, orgId, { userId: actorId }),
              );

            case "feature_impact":
              return Response.json(
                await core.featureImpact(supabase, orgId, String(payload["feature_key"]), {
                  userId: actorId,
                }),
              );

            case "set_feature":
              return Response.json(
                await core.setFeatureOverride(supabase, {
                  organizationId: orgId,
                  featureKey: String(payload["feature_key"]),
                  enabled: payload["enabled"] === true,
                  force: payload["force"] === true,
                  actorId,
                }),
              );

            case "save_billing_account":
              return Response.json(
                await admin.saveBillingAccount(supabase, {
                  actorId,
                  organizationId: orgId,
                  accountId: (payload["account_id"] as string) || null,
                  account: (payload["account"] ?? {}) as Record<string, unknown>,
                }),
              );

            case "link_billing_account":
              return Response.json(
                await admin.linkBillingAccount(supabase, {
                  actorId,
                  organizationId: orgId,
                  accountId: String(payload["account_id"]),
                }),
              );

            case "save_rate":
              return Response.json(
                await admin.saveRateCard(supabase, {
                  actorId,
                  organizationId: orgId,
                  countryCode: String(payload["country_code"] ?? "IN"),
                  category: String(payload["category"]),
                  mode: payload["mode"] === "fixed" ? "fixed" : "markup",
                  markupPercent:
                    payload["markup_percent"] === null || payload["markup_percent"] === undefined
                      ? null
                      : Number(payload["markup_percent"]),
                  fixedRate:
                    payload["fixed_rate"] === null || payload["fixed_rate"] === undefined
                      ? null
                      : Number(payload["fixed_rate"]),
                  effectiveFrom: String(
                    payload["effective_from"] ?? new Date().toISOString().slice(0, 10),
                  ),
                }),
              );

            case "save_settings":
              return Response.json(
                await admin.saveOrgBillingSettings(supabase, {
                  actorId,
                  organizationId: orgId,
                  settings: (payload["settings"] ?? {}) as Record<string, unknown>,
                  fundingModel: (payload["funding_model"] as string) || null,
                  billingDay:
                    payload["billing_day"] === null || payload["billing_day"] === undefined
                      ? null
                      : Number(payload["billing_day"]),
                }),
              );

            case "add_credits":
              return Response.json(
                await admin.adminAddCredits(supabase, {
                  actorId,
                  organizationId: orgId,
                  amount: Number(payload["amount"] ?? 0),
                  method: String(payload["method"] ?? "bank_transfer"),
                  reason: String(payload["reason"] ?? ""),
                }),
              );

            case "adjustment":
              return Response.json(
                await admin.adminAdjustment(supabase, {
                  actorId,
                  organizationId: orgId,
                  amount: Number(payload["amount"] ?? 0),
                  reason: String(payload["reason"] ?? ""),
                }),
              );

            case "onboarding_float":
              return Response.json(
                await admin.recordOnboardingFloat(supabase, {
                  actorId,
                  organizationId: orgId,
                  amount: Number(payload["amount"] ?? 0),
                  metaTxnRef: (payload["meta_txn_ref"] as string) || null,
                  whatsappAccountId: (payload["whatsapp_account_id"] as string) || null,
                }),
              );

            case "create_billing_templates": {
              const { ensureBillingTemplates } = await import("@/lib/billing-notify.server");
              return Response.json(await ensureBillingTemplates(supabase, actorId));
            }

            default:
              return jsonError("Unknown action.");
          }
        } catch (error) {
          return billingError(error);
        }
      },
    },
  },
});
