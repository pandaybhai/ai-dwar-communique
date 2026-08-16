import { createFileRoute } from "@tanstack/react-router";

type AnyRecord = Record<string, unknown>;

type IncomingRow = {
  row_number?: number;
  phone?: string;
  name?: string;
  tags?: string[];
  attributes?: Record<string, string>;
};

export const Route = createFileRoute("/api/contacts/import")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireOrgMember, isResponse, jsonError, logServerActivity } = await import(
          "@/lib/whatsapp-api.server"
        );
        const { normalizePhone, toWaId } = await import("@/lib/phone");

        let payload: AnyRecord;
        try {
          payload = (await request.json()) as AnyRecord;
        } catch {
          return jsonError("Invalid request.");
        }

        const auth = await requireOrgMember(request, (payload["organization_id"] as string) ?? null);
        if (isResponse(auth)) return auth;
        const { requirePermission } = await import("@/lib/whatsapp-api.server");
        const denied = await requirePermission(auth, "contacts.import", "import contacts");
        if (denied) return denied;
        const { supabase, organizationId, userId } = auth;
        const action = String(payload["action"] ?? "");

        // ---------------- start ----------------
        if (action === "start") {
          if (payload["consent"] !== true) {
            return jsonError("Confirm that these contacts have opted in before importing.");
          }
          const filename = String(payload["filename"] ?? "contacts.csv").slice(0, 200);
          const totalRows = Number(payload["total_rows"] ?? 0);
          if (totalRows > 10000) return jsonError("Imports are limited to 10,000 rows per file.");

          const { data, error } = await supabase
            .from("contact_imports")
            .insert({
              organization_id: organizationId,
              filename,
              total_rows: totalRows,
              status: "processing",
              created_by: userId,
            })
            .select("id")
            .single();
          if (error || !data) return jsonError("We couldn't start the import. Please try again.", 500);

          await logServerActivity(supabase, organizationId, userId, "contacts_import_consent", {
            filename,
            total_rows: totalRows,
            attestation: "opt_in_confirmed",
          });
          return Response.json({ import_id: data.id });
        }

        // ---------------- chunk ----------------
        if (action === "chunk") {
          const rows = (payload["rows"] as IncomingRow[] | undefined) ?? [];
          const consent = payload["consent"] === true;
          const importId = (payload["import_id"] as string | undefined) ?? null;
          if (rows.length > 1000) return jsonError("Chunk too large.");

          let created = 0;
          let updated = 0;
          const errors: { row: number; phone: string; reason: string }[] = [];

          // Resolve/create tags once per chunk.
          const tagNames = Array.from(
            new Set(
              rows.flatMap((r) => (r.tags ?? []).map((t) => t.trim()).filter(Boolean)),
            ),
          );
          const tagIds = new Map<string, string>();
          if (tagNames.length) {
            const { data: existing } = await supabase
              .from("tags")
              .select("id, name")
              .eq("organization_id", organizationId)
              .in("name", tagNames);
            for (const t of (existing ?? []) as { id: string; name: string }[]) {
              tagIds.set(t.name, t.id);
            }
            const missing = tagNames.filter((n) => !tagIds.has(n));
            if (missing.length) {
              const { data: inserted } = await supabase
                .from("tags")
                .insert(missing.map((name) => ({ organization_id: organizationId, name })))
                .select("id, name");
              for (const t of (inserted ?? []) as { id: string; name: string }[]) {
                tagIds.set(t.name, t.id);
              }
            }
          }

          for (const raw of rows) {
            const rowNumber = Number(raw.row_number ?? 0);
            const phone = normalizePhone(raw.phone ?? "");
            const digits = toWaId(phone);
            if (digits.length < 8 || digits.length > 15) {
              errors.push({
                row: rowNumber,
                phone: String(raw.phone ?? ""),
                reason: "Invalid phone number",
              });
              continue;
            }

            const { data: existing } = await supabase
              .from("contacts")
              .select("id, name, attributes")
              .eq("organization_id", organizationId)
              .eq("phone", phone)
              .maybeSingle();

            const name = (raw.name ?? "").trim();
            const attributes = raw.attributes ?? {};
            let contactId = existing?.id as string | undefined;

            if (contactId) {
              const merged = {
                ...((existing?.attributes as Record<string, unknown>) ?? {}),
                ...attributes,
              };
              const { error: updErr } = await supabase
                .from("contacts")
                .update({
                  name: name || (existing?.name as string | null) || null,
                  attributes: merged,
                  ...(consent ? { opt_in_status: "opted_in" } : {}),
                })
                .eq("id", contactId);
              if (updErr) {
                errors.push({ row: rowNumber, phone, reason: "Could not update contact" });
                continue;
              }
              updated += 1;
            } else {
              const { data: ins, error: insErr } = await supabase
                .from("contacts")
                .insert({
                  organization_id: organizationId,
                  phone,
                  wa_id: digits,
                  name: name || null,
                  attributes,
                  opt_in_status: consent ? "opted_in" : "unknown",
                  source: "import",
                  source_detail: importId ? { import_id: importId } : null,
                })
                .select("id")
                .single();
              if (insErr || !ins) {
                errors.push({ row: rowNumber, phone, reason: "Could not create contact" });
                continue;
              }
              contactId = ins.id as string;
              created += 1;
            }

            const rowTags = (raw.tags ?? []).map((t) => t.trim()).filter(Boolean);
            if (contactId && rowTags.length) {
              const links = rowTags
                .map((n) => tagIds.get(n))
                .filter((id): id is string => Boolean(id))
                .map((tagId) => ({
                  contact_id: contactId as string,
                  tag_id: tagId,
                  organization_id: organizationId,
                }));
              if (links.length) {
                await supabase.from("contact_tags").upsert(links, { onConflict: "contact_id,tag_id" });
              }
            }
          }

          return Response.json({ created, updated, errors });
        }

        // ---------------- finish ----------------
        if (action === "finish") {
          const importId = String(payload["import_id"] ?? "");
          if (!importId) return jsonError("Missing import reference.");
          const created = Number(payload["created_count"] ?? 0);
          const updatedCount = Number(payload["updated_count"] ?? 0);
          const skipped = Number(payload["skipped_count"] ?? 0);
          const errorReport = (payload["error_report"] as unknown[] | undefined) ?? [];
          const status = payload["status"] === "failed" ? "failed" : "completed";

          await supabase
            .from("contact_imports")
            .update({
              created_count: created,
              updated_count: updatedCount,
              skipped_count: skipped,
              error_report: errorReport.slice(0, 500),
              status,
            })
            .eq("id", importId)
            .eq("organization_id", organizationId);

          await logServerActivity(supabase, organizationId, userId, "contacts_imported", {
            import_id: importId,
            created_count: created,
            updated_count: updatedCount,
            skipped_count: skipped,
            status,
          });

          return Response.json({ ok: true });
        }

        return jsonError("Unsupported action.");
      },
    },
  },
});
