import { callApi } from "@/lib/whatsapp-client";

/**
 * Batch 76: where someone lands after logging in. A sales-only person (on the
 * sales team, in no workspace) goes straight to Leads & Demos; everyone else
 * to /app exactly as before. Any error answers /app.
 */
export async function landingAfterLogin(): Promise<"/admin/leads" | "/app"> {
  try {
    const { data } = await callApi<{ role?: string; has_workspace?: boolean }>(
      "/api/admin/access",
      {
        method: "GET",
      },
    );
    return data?.role === "sales" && data.has_workspace === false ? "/admin/leads" : "/app";
  } catch {
    return "/app";
  }
}
