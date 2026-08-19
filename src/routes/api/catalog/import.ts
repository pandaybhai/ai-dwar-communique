import { createFileRoute } from "@tanstack/react-router";

/**
 * Spreadsheet import. Rows arrive in chunks so a big file never times out, and
 * one bad row never stops the rest: failures are collected into error_report
 * with the row number and a plain reason the merchant can act on.
 *
 * Matching: SKU when the row has one, otherwise the exact product name. The
 * SKU uniqueness index is PARTIAL, so we look the row up ourselves rather than
 * relying on ON CONFLICT.
 */

type AnyRecord = Record<string, unknown>;

export const Route = createFileRoute("/api/catalog/import")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireOrgMember, requirePermission, isResponse, jsonError, logServerActivity } =
          await import("@/lib/whatsapp-api.server");
        const { recordUsage } = await import("@/lib/events.server");
        const { parsePrice, parseQuantity, parseAvailability } = await import("@/lib/catalog");
        

        let payload: AnyRecord;
        try {
          payload = (await request.json()) as AnyRecord;
        } catch {
          return jsonError("Invalid request.");
        }

        const auth = await requireOrgMember(request, (payload["organization_id"] as string) ?? null);
        if (isResponse(auth)) return auth;
        const denied = await requirePermission(auth, "catalog.import", "import products");
        if (denied) return denied;
        const { supabase, organizationId, userId } = auth;
        const action = String(payload["action"] ?? "");

        // ---------------- start ----------------
        if (action === "start") {
          const filename = String(payload["filename"] ?? "products.csv").slice(0, 200);
          const totalRows = Number(payload["total_rows"] ?? 0);
          if (totalRows > 10000) return jsonError("Imports are limited to 10,000 rows per file.");

          const { data, error } = await supabase
            .from("catalog_imports")
            .insert({
              organization_id: organizationId,
              filename,
              total_rows: totalRows,
              status: "processing",
              created_by: userId,
            })
            .select("id")
            .maybeSingle();
          if (error || !data) {
            return jsonError(error?.message ?? "We couldn't start the import.", 500);
          }
          return Response.json({ import_id: (data as AnyRecord)["id"] });
        }

        // ---------------- chunk ----------------
        if (action === "chunk") {
          const rows = (payload["rows"] as AnyRecord[] | undefined) ?? [];
          const importId = (payload["import_id"] as string | undefined) ?? null;
          if (rows.length > 200) return jsonError("Chunk too large.");

          let created = 0;
          let updated = 0;
          const errors: { row: number; product: string; reason: string }[] = [];

          for (const raw of rows) {
            const rowNumber = Number(raw["row_number"] ?? 0);
            const title = String(raw["title"] ?? "").trim().slice(0, 300);
            const sku = String(raw["sku"] ?? "").trim().slice(0, 100);

            if (!title && !sku) continue; // blank row
            if (!title) {
              errors.push({ row: rowNumber, product: sku, reason: "Missing product name" });
              continue;
            }

            const price = parsePrice(raw["price"]);
            const quantity = parseQuantity(raw["inventory_quantity"]);
            const fields = {
              organization_id: organizationId,
              title,
              sku: sku || null,
              description: String(raw["description"] ?? "").trim().slice(0, 5000) || null,
              brand: String(raw["brand"] ?? "").trim().slice(0, 120) || null,
              category: String(raw["category"] ?? "").trim().slice(0, 120) || null,
              price,
              compare_at_price: parsePrice(raw["compare_at_price"]),
              inventory_quantity: quantity,
              availability: parseAvailability(raw["availability"], quantity),
              image_url: String(raw["image_url"] ?? "").trim().slice(0, 1000) || null,
              product_url: String(raw["product_url"] ?? "").trim().slice(0, 1000) || null,
              currency: "INR",
              source: "import" as const,
            };

            try {
              let existingId: string | null = null;
              if (sku) {
                const { data: bySku, error: skuError } = await supabase
                  .from("products")
                  .select("id")
                  .eq("organization_id", organizationId)
                  .ilike("sku", sku)
                  .limit(1)
                  .maybeSingle();
                if (skuError) throw new Error(skuError.message);
                existingId = (bySku as AnyRecord | null)?.["id"] as string | null;
              } else {
                const { data: byTitle, error: titleError } = await supabase
                  .from("products")
                  .select("id")
                  .eq("organization_id", organizationId)
                  .eq("title", title)
                  .limit(1)
                  .maybeSingle();
                if (titleError) throw new Error(titleError.message);
                existingId = (byTitle as AnyRecord | null)?.["id"] as string | null;
              }

              if (existingId) {
                const { organization_id: _org, source: _source, ...patch } = fields;
                const { error } = await supabase
                  .from("products")
                  .update(patch)
                  .eq("id", existingId)
                  .eq("organization_id", organizationId);
                if (error) throw new Error(error.message);
                updated += 1;
              } else {
                const { error } = await supabase
                  .from("products")
                  .insert({ ...fields, created_by: userId });
                if (error) throw new Error(error.message);
                created += 1;
              }
            } catch (caught) {
              errors.push({
                row: rowNumber,
                product: title || sku,
                reason: caught instanceof Error ? caught.message : "Could not save this row",
              });
            }
          }

          if (importId) {
            const { data: current } = await supabase
              .from("catalog_imports")
              .select("rows_created, rows_updated, rows_failed, error_report")
              .eq("id", importId)
              .eq("organization_id", organizationId)
              .maybeSingle();
            const row = (current ?? {}) as AnyRecord;
            const previousErrors = Array.isArray(row["error_report"])
              ? (row["error_report"] as unknown[])
              : [];
            const { error: updateError } = await supabase
              .from("catalog_imports")
              .update({
                rows_created: Number(row["rows_created"] ?? 0) + created,
                rows_updated: Number(row["rows_updated"] ?? 0) + updated,
                rows_failed: Number(row["rows_failed"] ?? 0) + errors.length,
                error_report: [...previousErrors, ...errors].slice(0, 500),
              })
              .eq("id", importId)
              .eq("organization_id", organizationId);
            if (updateError) return jsonError(updateError.message, 500);
          }

          return Response.json({ created, updated, errors });
        }

        // ---------------- finish ----------------
        if (action === "finish") {
          const importId = (payload["import_id"] as string | undefined) ?? null;
          if (!importId) return jsonError("Missing import.");
          const { data, error } = await supabase
            .from("catalog_imports")
            .update({ status: "completed", completed_at: new Date().toISOString() })
            .eq("id", importId)
            .eq("organization_id", organizationId)
            .select("filename, total_rows, rows_created, rows_updated, rows_failed")
            .maybeSingle();
          if (error) return jsonError(error.message, 500);
          const summary = (data ?? {}) as AnyRecord;

          const imported = Number(summary["rows_created"] ?? 0) + Number(summary["rows_updated"] ?? 0);
          await recordUsage(supabase, "catalog_imports", {
            organizationId,
            quantity: imported,
            metadata: { import_id: importId },
          });
          await logServerActivity(supabase, organizationId, userId, "catalog_imported", {
            import_id: importId,
            filename: summary["filename"],
            created: summary["rows_created"],
            updated: summary["rows_updated"],
            failed: summary["rows_failed"],
          });
          return Response.json({ summary });
        }

        if (action === "fail") {
          const importId = (payload["import_id"] as string | undefined) ?? null;
          if (!importId) return jsonError("Missing import.");
          const { error } = await supabase
            .from("catalog_imports")
            .update({ status: "failed", completed_at: new Date().toISOString() })
            .eq("id", importId)
            .eq("organization_id", organizationId);
          if (error) return jsonError(error.message, 500);
          return Response.json({ ok: true });
        }

        return jsonError("Unknown action.");
      },
    },
  },
});
