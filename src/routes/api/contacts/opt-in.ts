import { createFileRoute } from "@tanstack/react-router";

type AnyRecord = Record<string, unknown>;

const MAX_SELECTED = 1000;

/**
 * Batch 36: the merchant's opt-in switches — "Add contact" and the contact
 * drawer ("set"), the Contacts list's "Mark as opted in" ("bulk") and "Mark
 * all unknown as opted in" ("count_unknown", then "all_unknown"). All writes
 * go through src/lib/opt-in.server.ts; an opt-out never changes here.
 */
export const Route = createFileRoute("/api/contacts/opt-in")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { requireOrgMember, requirePermission, isResponse, jsonError } = await import(
          "@/lib/whatsapp-api.server"
        );
        const { markContactsOptedIn, setContactOptIn } = await import("@/lib/opt-in.server");

        let payload: AnyRecord;
        try {
          payload = (await request.json()) as AnyRecord;
        } catch {
          return jsonError("Invalid request.");
        }

        const auth = await requireOrgMember(request, (payload["organization_id"] as string) ?? null);
        if (isResponse(auth)) return auth;
        const denied = await requirePermission(auth, "contacts.edit", "edit contacts");
        if (denied) return denied;
        const { supabase, organizationId, userId } = auth;
        const action = String(payload["action"] ?? "");

        if (action === "set") {
          const contactId = String(payload["contact_id"] ?? "");
          const status = String(payload["status"] ?? "");
          if (!contactId) return jsonError("Missing contact.");
          if (status !== "opted_in" && status !== "unknown" && status !== "opted_out") {
            return jsonError("Unsupported opt-in status.");
          }
          const res = await setContactOptIn(supabase, { organizationId, userId, contactId, status });
          if (res.error) return jsonError(res.error, res.status ? 409 : 500);
          return Response.json({ status: res.status, changed: res.changed });
        }

        if (action === "bulk") {
          const ids = Array.isArray(payload["contact_ids"])
            ? (payload["contact_ids"] as unknown[]).filter((v): v is string => typeof v === "string")
            : [];
          if (!ids.length) return jsonError("Select at least one contact.");
          if (ids.length > MAX_SELECTED) return jsonError(`Select up to ${MAX_SELECTED} contacts at a time.`);
          const { result, error } = await markContactsOptedIn(supabase, {
            organizationId,
            userId,
            source: "bulk",
            contactIds: ids,
          });
          if (error) return jsonError("We couldn't update these contacts. Please try again.", 500);
          return Response.json(result);
        }

        if (action === "count_unknown") {
          const { count, error } = await supabase
            .from("contacts")
            .select("id", { count: "exact", head: true })
            .eq("organization_id", organizationId)
            .eq("opt_in_status", "unknown");
          if (error) return jsonError("We couldn't count your contacts. Please try again.", 500);
          return Response.json({ count: count ?? 0 });
        }

        if (action === "all_unknown") {
          const { result, error } = await markContactsOptedIn(supabase, {
            organizationId,
            userId,
            source: "bulk",
            contactIds: "all_unknown",
          });
          if (error) return jsonError("We couldn't update your contacts. Please try again.", 500);
          return Response.json(result);
        }

        return jsonError("Unsupported action.");
      },
    },
  },
});
