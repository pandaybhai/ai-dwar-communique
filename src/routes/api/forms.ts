import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const FieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  type: z.enum(["text", "long_text", "dropdown", "radio", "checkbox", "date", "opt_in"]),
  label: z.string().min(1).max(120),
  required: z.boolean(),
  options: z.array(z.string().max(60)).max(20).optional(),
  helper: z.string().max(80).optional(),
  map_to: z.enum(["", "name", "email", "pincode", "phone"]).optional(),
});

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), organization_id: z.string().uuid() }),
  z.object({
    action: z.literal("save"),
    organization_id: z.string().uuid(),
    id: z.string().uuid().optional(),
    name: z.string().min(1).max(60),
    purpose: z.string().max(40).optional().nullable(),
    cta: z.string().min(1).max(20),
    intro: z.string().max(1000).optional().nullable(),
    whatsapp_account_id: z.string().uuid().optional().nullable(),
    fields: z.array(FieldSchema).min(1).max(20),
  }),
  z.object({ action: z.literal("publish"), organization_id: z.string().uuid(), id: z.string().uuid() }),
  z.object({ action: z.literal("delete"), organization_id: z.string().uuid(), id: z.string().uuid() }),
  z.object({
    action: z.literal("send"),
    organization_id: z.string().uuid(),
    id: z.string().uuid(),
    conversation_id: z.string().uuid(),
    body: z.string().max(1000).optional().nullable(),
  }),
  z.object({
    action: z.literal("responses"),
    organization_id: z.string().uuid(),
    id: z.string().uuid().optional(),
  }),
]);

export const Route = createFileRoute("/api/forms")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireOrgMember, isResponse, jsonError, requirePermission } = await import(
          "@/lib/whatsapp-api.server"
        );
        let parsed: z.infer<typeof Body>;
        try {
          parsed = Body.parse(await request.json());
        } catch {
          return jsonError("Invalid request.");
        }
        // The organization comes from the caller's membership, never trusted as sent.
        const auth = await requireOrgMember(request, parsed.organization_id);
        if (isResponse(auth)) return auth;
        const { supabase, organizationId, userId } = auth;

        const { enabledFlags } = await import("@/lib/ai-tools.server");
        const flags = await enabledFlags(supabase, organizationId);
        if (!flags.has("wa_forms")) return jsonError("Forms aren't switched on for this workspace.", 403);

        const { validateForm } = await import("@/lib/wa-forms");
        const log = (action: string, details: Record<string, unknown>) =>
          supabase.from("activity_log").insert({ organization_id: organizationId, user_id: userId, action, details });

        if (parsed.action === "list") {
          const { data } = await supabase
            .from("wa_forms")
            .select("id, organization_id, whatsapp_account_id, parent_id, version, name, purpose, cta, intro, fields, meta_flow_id, status, last_error, published_at, created_at, updated_at")
            .eq("organization_id", organizationId)
            .neq("status", "deprecated")
            .order("created_at", { ascending: false });
          const { data: counts } = await supabase
            .from("wa_form_responses")
            .select("form_id")
            .eq("organization_id", organizationId)
            .limit(5000);
          const byForm: Record<string, number> = {};
          for (const r of (counts ?? []) as Array<{ form_id: string | null }>) {
            if (r.form_id) byForm[r.form_id] = (byForm[r.form_id] ?? 0) + 1;
          }
          return Response.json({ forms: data ?? [], response_counts: byForm });
        }

        if (parsed.action === "responses") {
          const denied = await requirePermission(auth, "inbox.view", "see form answers");
          if (denied) return denied;
          let q = supabase
            .from("wa_form_responses")
            .select("id, form_id, contact_id, conversation_id, answers, received_at, contacts(name, phone)")
            .eq("organization_id", organizationId)
            .order("received_at", { ascending: false })
            .limit(100);
          if (parsed.id) q = q.eq("form_id", parsed.id);
          const { data } = await q;
          return Response.json({ responses: data ?? [] });
        }

        if (parsed.action === "send") {
          const denied = await requirePermission(auth, "inbox.reply", "send forms");
          if (denied) return denied;
          const { sendFormMessage } = await import("@/lib/wa-forms.server");
          const result = await sendFormMessage(supabase, {
            organizationId,
            conversationId: parsed.conversation_id,
            formId: parsed.id,
            sentBy: userId,
            body: parsed.body ?? null,
            source: "inbox",
          });
          if (!result.ok) return jsonError(result.error ?? "Couldn't send the form.", 400);
          return Response.json({ ok: true, message_id: result.messageId });
        }

        const denied = await requirePermission(auth, "ai.configure", "change forms");
        if (denied) return denied;

        if (parsed.action === "save") {
          const problem = validateForm({ name: parsed.name, fields: parsed.fields });
          if (problem) return jsonError(problem);
          const values = {
            name: parsed.name.trim(),
            purpose: parsed.purpose ?? null,
            cta: parsed.cta.trim(),
            intro: parsed.intro?.trim() || null,
            fields: parsed.fields,
            ...(parsed.whatsapp_account_id !== undefined
              ? { whatsapp_account_id: parsed.whatsapp_account_id }
              : {}),
          };
          if (parsed.id) {
            const { data: existing } = await supabase
              .from("wa_forms")
              .select("id, status, version, whatsapp_account_id")
              .eq("id", parsed.id)
              .eq("organization_id", organizationId)
              .maybeSingle();
            const row = existing as { id: string; status: string; version: number; whatsapp_account_id: string | null } | null;
            if (!row) return jsonError("That form doesn't exist.", 404);
            if (row.status === "published") {
              // Changing a live form makes a new draft version; the live one keeps working.
              const { data: created, error } = await supabase
                .from("wa_forms")
                .insert({
                  organization_id: organizationId,
                  parent_id: row.id,
                  version: row.version + 1,
                  whatsapp_account_id: row.whatsapp_account_id,
                  created_by: userId,
                  status: "draft",
                  ...values,
                })
                .select("id")
                .single();
              if (error) return jsonError("Couldn't save the form.", 500);
              await log("form_created", { form_id: created.id, version: row.version + 1, from: row.id });
              return Response.json({ ok: true, id: created.id, new_version: true });
            }
            const { error } = await supabase
              .from("wa_forms")
              .update({ ...values, status: "draft", last_error: null })
              .eq("id", row.id);
            if (error) return jsonError("Couldn't save the form.", 500);
            return Response.json({ ok: true, id: row.id });
          }
          const { data: created, error } = await supabase
            .from("wa_forms")
            .insert({ organization_id: organizationId, created_by: userId, status: "draft", ...values })
            .select("id")
            .single();
          if (error) return jsonError("Couldn't save the form.", 500);
          await log("form_created", { form_id: created.id, version: 1 });
          return Response.json({ ok: true, id: created.id });
        }

        if (parsed.action === "delete") {
          const { data: row } = await supabase
            .from("wa_forms")
            .select("id, status")
            .eq("id", parsed.id)
            .eq("organization_id", organizationId)
            .maybeSingle();
          if (!row) return jsonError("That form doesn't exist.", 404);
          if ((row as { status: string }).status === "published") {
            await supabase.from("wa_forms").update({ status: "deprecated" }).eq("id", parsed.id);
          } else {
            await supabase.from("wa_forms").delete().eq("id", parsed.id);
          }
          return Response.json({ ok: true });
        }

        // publish
        const { data: formRow } = await supabase
          .from("wa_forms")
          .select("*")
          .eq("id", parsed.id)
          .eq("organization_id", organizationId)
          .maybeSingle();
        if (!formRow) return jsonError("That form doesn't exist.", 404);
        const { publishForm } = await import("@/lib/wa-forms.server");
        const { type FormRow: _ } = {} as never;
        void _;
        const result = await publishForm(supabase, formRow as import("@/lib/wa-forms").FormRow);
        if (result.ok) {
          await log("form_published", { form_id: parsed.id, meta_flow_id: result.metaFlowId });
          return Response.json({ ok: true, meta_flow_id: result.metaFlowId });
        }
        return Response.json({ ok: false, error: result.error }, { status: 422 });
      },
    },
  },
});
