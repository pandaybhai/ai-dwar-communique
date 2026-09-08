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
              const data = await admin.adminOverview(supabase, actorId, {
                month: (payload["month"] as string) || null,
              });
              return Response.json(data);
            }
            case "sync_number":
              return Response.json(
                await admin.adminSyncNumber(supabase, {
                  actorId,
                  whatsappAccountId: String(payload["whatsapp_account_id"] ?? ""),
                }),
              );

            case "reconcile":
              return Response.json(
                await admin.adminReconcile(supabase, actorId, {
                  months: Number(payload["months"] ?? 6),
                  from: (payload["from"] as string) || null,
                  to: (payload["to"] as string) || null,
                }),
              );

            case "ai_runs_detail": {
              if (!orgId) return jsonError("Which workspace?");
              const month = String(payload["month"] ?? "");
              if (!/^\d{4}-\d{2}$/.test(month)) return jsonError("Which month?");
              const [year, mon] = month.split("-").map(Number) as [number, number];
              const { aiRunDetail } = await import("@/lib/billing-ai-economics.server");
              return Response.json(
                await aiRunDetail(supabase, {
                  organizationId: orgId,
                  fromIso: new Date(Date.UTC(year, mon - 1, 1)).toISOString(),
                  toIso: new Date(Date.UTC(year, mon, 1)).toISOString(),
                }),
              );
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

            case "plan_change_preview":
              return Response.json(
                await core.planChangePreview(supabase, {
                  organizationId: orgId,
                  planKey: String(payload["plan_key"] ?? ""),
                  actorId,
                }),
              );

            case "assign_plan":
              return Response.json(
                await core.assignPlan(supabase, {
                  organizationId: orgId,
                  planKey: String(payload["plan_key"] ?? ""),
                  actorId,
                  confirm: payload["confirm"] === true,
                  ...(payload["status"] ? { status: String(payload["status"]) } : {}),
                  ...(payload["trial_days"] === undefined
                    ? {}
                    : { trialDays: Number(payload["trial_days"]) }),
                  ...(payload["funding_model"]
                    ? {
                        fundingModel: String(payload["funding_model"]) as
                          | "meta_direct"
                          | "aidwar_prepaid"
                          | "bsp",
                      }
                    : {}),
                }),
              );

            case "resync_plan_features":
              return Response.json(
                await core.resyncPlanFeatures(supabase, {
                  organizationId: orgId,
                  actorId,
                }),
              );

            case "resync_plan_features_all":
              return Response.json(await core.resyncAllPlanFeatures(supabase, actorId));

            case "recommend_plan":
              return Response.json(await core.recommendPlan(supabase, orgId, { userId: actorId }));

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

            case "issue_pending_invoices": {
              const { issuePendingInvoices } = await import("@/lib/invoices.server");
              return Response.json(await issuePendingInvoices(supabase));
            }

            case "invoices": {
              const status = (payload["status"] as string) || null;
              const purpose = (payload["purpose"] as string) || null;
              const month = (payload["month"] as string) || null; // YYYY-MM
              const search = ((payload["search"] as string) || "").trim();
              let query = supabase
                .from("invoices")
                .select(
                  "id, organization_id, invoice_number, kind, purpose, status, issue_date, due_date, period_start, period_end, subtotal, taxable_value, cgst, sgst, igst, total, amount_paid, currency, pdf_path, sent, payment_id, is_interstate, is_export, place_of_supply, created_at, organizations(name)",
                )
                .order("created_at", { ascending: false })
                .limit(300);
              if (orgId) query = query.eq("organization_id", orgId);
              if (status) query = query.eq("status", status);
              if (purpose) query = query.eq("purpose", purpose);
              if (month && /^\d{4}-\d{2}$/.test(month)) {
                const start = `${month}-01`;
                const next = new Date(`${start}T00:00:00Z`);
                next.setUTCMonth(next.getUTCMonth() + 1);
                query = query.gte("issue_date", start).lt("issue_date", next.toISOString().slice(0, 10));
              }
              if (search) query = query.ilike("invoice_number", `%${search}%`);
              const { data, error } = await query;
              if (error) return jsonError("We couldn't load invoices.");
              const rows = ((data ?? []) as Record<string, unknown>[]).map((r) => ({
                ...r,
                organization_name:
                  ((r["organizations"] as Record<string, unknown> | null)?.["name"] as string) ?? null,
                organizations: undefined,
                pay_url: ((r["sent"] as Record<string, unknown> | null)?.["pay_url"] as string) ?? null,
                whatsapp_at:
                  ((r["sent"] as Record<string, unknown> | null)?.["whatsapp_at"] as string) ?? null,
                pdf_error: ((r["sent"] as Record<string, unknown> | null)?.["pdf_error"] as string) ?? null,
              }));
              return Response.json({ invoices: rows });
            }

            case "invoice_pdf_url": {
              const { ensureInvoicePdf, invoiceDownloadUrl } = await import("@/lib/invoices.server");
              const path = await ensureInvoicePdf(supabase, String(payload["invoice_id"] ?? ""));
              if (!path) return jsonError("The PDF isn't available for this invoice.");
              const url = await invoiceDownloadUrl(supabase, path);
              if (!url) return jsonError("We couldn't open that PDF.");
              return Response.json({ url });
            }

            case "regenerate_invoice_pdf": {
              const { ensureInvoicePdf } = await import("@/lib/invoices.server");
              const path = await ensureInvoicePdf(supabase, String(payload["invoice_id"] ?? ""), {
                force: true,
              });
              if (!path) return jsonError("We couldn't regenerate that PDF — check the invoice's pdf_error.");
              return Response.json({ ok: true, pdf_path: path });
            }

            case "resend_invoice": {
              const { deliverInvoice } = await import("@/lib/invoices.server");
              const result = await deliverInvoice(supabase, String(payload["invoice_id"] ?? ""), {
                fallbackToQueue: false,
              });
              if (!result.ok) return jsonError(result.error);
              return Response.json(result);
            }

            case "issue_credit_note": {
              const { issueCreditNote } = await import("@/lib/credit-notes.server");
              const result = await issueCreditNote(supabase, {
                invoiceId: String(payload["invoice_id"] ?? ""),
                amount: Number(payload["amount"] ?? 0),
                reason: String(payload["reason"] ?? ""),
                refundToWallet: payload["refund_to_wallet"] === true,
                actorId,
              });
              if ("error" in result) return jsonError(result.error);
              return Response.json(result);
            }

            case "credit_notes": {
              const { listCreditNotes } = await import("@/lib/credit-notes.server");
              return Response.json({
                credit_notes: await listCreditNotes(supabase, {
                  organizationId: orgId || null,
                  invoiceId: (payload["invoice_id"] as string) || null,
                }),
              });
            }

            case "credit_note_pdf_url": {
              const { invoiceDownloadUrl } = await import("@/lib/invoices.server");
              const { data: note } = await supabase
                .from("credit_notes")
                .select("pdf_path")
                .eq("id", String(payload["credit_note_id"] ?? ""))
                .maybeSingle();
              const path = (note?.["pdf_path"] as string | null) ?? null;
              if (!path) return jsonError("The PDF isn't available for this credit note.");
              const url = await invoiceDownloadUrl(supabase, path);
              if (!url) return jsonError("We couldn't open that PDF.");
              return Response.json({ url });
            }

            case "invoice_reconciliation": {
              // Paid money with no tax document, and tax documents with no money.
              const [{ data: payments }, { data: invoices }] = await Promise.all([
                supabase
                  .from("payments")
                  .select("id, organization_id, purpose, amount, status, paid_at, created_at, organizations(name)")
                  .eq("status", "paid")
                  .in("purpose", ["credit_purchase", "plan_fee"])
                  .order("paid_at", { ascending: false })
                  .limit(500),
                supabase
                  .from("invoices")
                  .select("id, organization_id, invoice_number, purpose, status, total, amount_paid, issue_date, due_date, payment_id, organizations(name)")
                  .eq("kind", "tax_invoice")
                  .neq("status", "void")
                  .order("issue_date", { ascending: false })
                  .limit(1000),
              ]);
              const invoiceRows = (invoices ?? []) as Record<string, unknown>[];
              const byPayment = new Set(
                invoiceRows.map((i) => i["payment_id"]).filter(Boolean) as string[],
              );
              const name = (r: Record<string, unknown>) =>
                ((r["organizations"] as Record<string, unknown> | null)?.["name"] as string) ?? null;
              const paymentsWithoutInvoice = ((payments ?? []) as Record<string, unknown>[])
                .filter((p) => !byPayment.has(String(p["id"])))
                .map((p) => ({ ...p, organization_name: name(p), organizations: undefined }));
              const invoicesWithoutPayment = invoiceRows
                .filter((i) => !i["payment_id"] && Number(i["amount_paid"] ?? 0) <= 0)
                .map((i) => ({ ...i, organization_name: name(i), organizations: undefined }));
              return Response.json({
                payments_without_invoice: paymentsWithoutInvoice,
                invoices_without_payment: invoicesWithoutPayment,
              });
            }

            case "billing_templates": {
              const { listBillingTemplates } = await import("@/lib/billing-notify.server");
              return Response.json({ templates: await listBillingTemplates(supabase) });
            }

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
