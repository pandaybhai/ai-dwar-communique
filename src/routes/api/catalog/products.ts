import { createFileRoute } from "@tanstack/react-router";

/**
 * Every catalogue write goes through here so that permission, activity logging
 * and the Shopify-ownership rules live in one place. Reads happen straight
 * from the browser under RLS.
 */

type AnyRecord = Record<string, unknown>;

const text = (v: unknown, max = 500): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, max) : null;
};

/** 0 is a real number. Only null, undefined and "" mean "not set". */
const numberOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const intOrNull = (v: unknown): number | null => {
  const n = numberOrNull(v);
  return n === null ? null : Math.round(n);
};


export const Route = createFileRoute("/api/catalog/products")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireOrgMember, requirePermission, isResponse, jsonError, logServerActivity } =
          await import("@/lib/whatsapp-api.server");
        const { isAvailability, slugify } = await import("@/lib/catalog");

        let payload: AnyRecord;
        try {
          payload = (await request.json()) as AnyRecord;
        } catch {
          return jsonError("Invalid request.");
        }

        const auth = await requireOrgMember(request, (payload["organization_id"] as string) ?? null);
        if (isResponse(auth)) return auth;
        const denied = await requirePermission(auth, "catalog.manage", "manage the catalogue");
        if (denied) return denied;
        const { supabase, organizationId, userId } = auth;
        const action = String(payload["action"] ?? "");

        // ------------------------------------------------------- products
        if (action === "save") {
          const id = text(payload["id"], 60);
          const title = text(payload["title"], 300);
          if (!title) return jsonError("Give the product a name.");

          const availabilityRaw = payload["availability"];
          const fields = {
            title,
            description: text(payload["description"], 5000),
            sku: text(payload["sku"], 100),
            brand: text(payload["brand"], 120),
            category: text(payload["category"], 120),
            price: numberOrNull(payload["price"]),
            compare_at_price: numberOrNull(payload["compare_at_price"]),
            currency: text(payload["currency"], 8) ?? "INR",
            availability: isAvailability(availabilityRaw) ? availabilityRaw : "in_stock",
            inventory_quantity: intOrNull(payload["inventory_quantity"]),

            image_url: text(payload["image_url"], 1000),
            additional_image_urls: Array.isArray(payload["additional_image_urls"])
              ? (payload["additional_image_urls"] as unknown[])
                  .map((u) => text(u, 1000))
                  .filter((u): u is string => Boolean(u))
                  .slice(0, 10)
              : [],
            product_url: text(payload["product_url"], 1000),
            is_visible: payload["is_visible"] !== false,
          };

          if (id) {
            const { data, error } = await supabase
              .from("products")
              .update(fields)
              .eq("id", id)
              .eq("organization_id", organizationId)
              .select("id, title, source")
              .maybeSingle();
            if (error) return jsonError(error.message, 400);
            if (!data) return jsonError("That product is no longer in this catalogue.", 404);
            await logServerActivity(supabase, organizationId, userId, "catalog_product_updated", {
              product_id: id,
              title: fields.title,
              source: (data as AnyRecord)["source"],
            });
            return Response.json({ product: data });
          }

          const { data, error } = await supabase
            .from("products")
            .insert({
              ...fields,
              organization_id: organizationId,
              source: "manual",
              created_by: userId,
            })
            .select("id, title")
            .maybeSingle();
          if (error) {
            // The SKU index is partial and unique per workspace.
            if (error.code === "23505") {
              return jsonError("A product with that SKU already exists in this catalogue.", 400);
            }
            return jsonError(error.message, 400);
          }
          await logServerActivity(supabase, organizationId, userId, "catalog_product_created", {
            product_id: (data as AnyRecord | null)?.["id"],
            title: fields.title,
          });
          return Response.json({ product: data });
        }

        if (action === "delete") {
          const ids = (payload["ids"] as string[] | undefined) ?? [];
          if (!ids.length) return jsonError("Choose at least one product.");
          const { error, count } = await supabase
            .from("products")
            .delete({ count: "exact" })
            .in("id", ids)
            .eq("organization_id", organizationId);
          if (error) return jsonError(error.message, 400);
          await logServerActivity(supabase, organizationId, userId, "catalog_product_deleted", {
            count: count ?? ids.length,
          });
          return Response.json({ deleted: count ?? ids.length });
        }

        if (action === "set_visibility") {
          const ids = (payload["ids"] as string[] | undefined) ?? [];
          const visible = payload["is_visible"] === true;
          if (!ids.length) return jsonError("Choose at least one product.");
          const { error, count } = await supabase
            .from("products")
            .update({ is_visible: visible }, { count: "exact" })
            .in("id", ids)
            .eq("organization_id", organizationId);
          if (error) return jsonError(error.message, 400);
          await logServerActivity(supabase, organizationId, userId, "catalog_products_hidden", {
            count: count ?? ids.length,
            is_visible: visible,
          });
          return Response.json({ updated: count ?? ids.length });
        }

        if (action === "unlink") {
          const id = text(payload["id"], 60);
          if (!id) return jsonError("Choose a product to unlink.");
          const { data, error } = await supabase
            .from("products")
            .update({ integration_id: null, external_id: null, source: "manual" })
            .eq("id", id)
            .eq("organization_id", organizationId)
            .select("id, title")
            .maybeSingle();
          if (error) return jsonError(error.message, 400);
          if (!data) return jsonError("That product is no longer in this catalogue.", 404);
          await logServerActivity(supabase, organizationId, userId, "catalog_product_unlinked", {
            product_id: id,
          });
          return Response.json({ product: data });
        }

        // ---------------------------------------------------- collections
        if (action === "collection_save") {
          const id = text(payload["id"], 60);
          const name = text(payload["name"], 120);
          if (!name) return jsonError("Give the collection a name.");
          const fields = {
            name,
            slug: text(payload["slug"], 60) ?? slugify(name),
            description: text(payload["description"], 1000),
            image_url: text(payload["image_url"], 1000),
          };

          if (id) {
            const { data, error } = await supabase
              .from("product_collections")
              .update(fields)
              .eq("id", id)
              .eq("organization_id", organizationId)
              .select("id, name, slug")
              .maybeSingle();
            if (error) {
              return jsonError(
                error.code === "23505"
                  ? "Another collection already uses that name."
                  : error.message,
                400,
              );
            }
            if (!data) return jsonError("That collection no longer exists.", 404);
            await logServerActivity(
              supabase,
              organizationId,
              userId,
              "catalog_collection_updated",
              { collection_id: id, name },
            );
            return Response.json({ collection: data });
          }

          const { data, error } = await supabase
            .from("product_collections")
            .insert({ ...fields, organization_id: organizationId })
            .select("id, name, slug")
            .maybeSingle();
          if (error) {
            return jsonError(
              error.code === "23505" ? "A collection with that name already exists." : error.message,
              400,
            );
          }
          await logServerActivity(supabase, organizationId, userId, "catalog_collection_created", {
            collection_id: (data as AnyRecord | null)?.["id"],
            name,
          });
          return Response.json({ collection: data });
        }

        if (action === "collection_delete") {
          const id = text(payload["id"], 60);
          if (!id) return jsonError("Choose a collection.");
          const { error } = await supabase
            .from("product_collections")
            .delete()
            .eq("id", id)
            .eq("organization_id", organizationId);
          if (error) return jsonError(error.message, 400);
          await logServerActivity(supabase, organizationId, userId, "catalog_collection_deleted", {
            collection_id: id,
          });
          return Response.json({ ok: true });
        }

        if (action === "collection_reorder") {
          const ids = (payload["ids"] as string[] | undefined) ?? [];
          for (let i = 0; i < ids.length; i += 1) {
            const { error } = await supabase
              .from("product_collections")
              .update({ sort_order: i })
              .eq("id", ids[i] as string)
              .eq("organization_id", organizationId);
            if (error) return jsonError(error.message, 400);
          }
          return Response.json({ ok: true });
        }

        if (action === "collection_assign") {
          const collectionId = text(payload["collection_id"], 60);
          const productIds = (payload["product_ids"] as string[] | undefined) ?? [];
          const remove = payload["remove"] === true;
          if (!collectionId || !productIds.length) {
            return jsonError("Choose a collection and at least one product.");
          }

          if (remove) {
            const { error } = await supabase
              .from("product_collection_items")
              .delete()
              .eq("collection_id", collectionId)
              .eq("organization_id", organizationId)
              .in("product_id", productIds);
            if (error) return jsonError(error.message, 400);
          } else {
            const { error } = await supabase.from("product_collection_items").upsert(
              productIds.map((productId, index) => ({
                collection_id: collectionId,
                product_id: productId,
                organization_id: organizationId,
                sort_order: index,
              })),
              { onConflict: "collection_id,product_id" },
            );
            if (error) return jsonError(error.message, 400);
          }
          await logServerActivity(supabase, organizationId, userId, "catalog_collection_updated", {
            collection_id: collectionId,
            products: productIds.length,
            removed: remove,
          });
          return Response.json({ ok: true });
        }

        return jsonError("Unknown action.");
      },
    },
  },
});
