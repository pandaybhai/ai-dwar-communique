import { createFileRoute } from "@tanstack/react-router";

/**
 * Super-admin only: list, grant and revoke platform super admins.
 * Grants only work for existing accounts; you can't remove yourself or the last one.
 * test_email sends a test email to the signed-in admin's own address and
 * answers with Resend's real error text when it fails.
 */
export const Route = createFileRoute("/api/admin/super-admins")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const { isSuperAdmin, jsonError, logServerActivity } = await import("@/lib/whatsapp-api.server");

        const header = request.headers.get("authorization") ?? "";
        const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
        if (!token) return jsonError("Not authenticated.", 401);
        const supabase = getServiceClient();
        const { data: userData } = await supabase.auth.getUser(token);
        const user = userData.user;
        if (!user) return jsonError("Not authenticated.", 401);
        if (!(await isSuperAdmin(supabase, user.id))) return jsonError("Super Admin access required.", 403);

        const body = (await request.json().catch(() => ({}))) as { action?: string; email?: string; user_id?: string };

        const list = async () => {
          const { data } = await supabase
            .from("profiles")
            .select("id, full_name, email, created_at")
            .eq("is_super_admin", true)
            .order("created_at", { ascending: true });
          return (data ?? []) as { id: string; full_name: string | null; email: string | null; created_at: string }[];
        };

        if (body.action === "list") return Response.json({ admins: await list(), me: user.id });

        if (body.action === "test_email") {
          const { sendEmail, DEFAULT_EMAIL_FROM } = await import("@/lib/email.server");
          const to = String(user.email ?? "").trim();
          if (!to) return jsonError("Your account has no email address.", 400);
          const from = process.env["EMAIL_FROM"]?.trim() || DEFAULT_EMAIL_FROM;
          const mail = await sendEmail({
            to,
            subject: "AiDwar test email",
            body:
              `This is a test email from AiDwar, sent from the admin area at ${new Date().toISOString()}.\n\n` +
              `It was sent from ${from} to ${to}. If you can read this, email sending works.`,
          });
          const { resolvePlatformOrg } = await import("@/lib/billing-notify.server");
          const platformOrg = await resolvePlatformOrg(supabase).catch(() => null);
          if (platformOrg)
            await logServerActivity(supabase, platformOrg, user.id, "test_email_sent", { ok: mail.ok, email_id: mail.id ?? null, error: mail.error ?? null }).catch(() => undefined);
          return Response.json({ sent: mail.ok, to, id: mail.id ?? null, error: mail.error ?? null });
        }

        const { resolvePlatformOrg } = await import("@/lib/billing-notify.server");
        const { sendEmail } = await import("@/lib/email.server");
        const platformOrg = await resolvePlatformOrg(supabase).catch(() => null);
        const actorName = (user.email ?? "A super admin") as string;

        if (body.action === "grant") {
          const email = String(body.email ?? "").trim().toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonError("Enter a valid email address.", 400);
          const { data: target } = await supabase
            .from("profiles")
            .select("id, email, is_super_admin")
            .ilike("email", email)
            .maybeSingle();
          if (!target) return jsonError("No AiDwar account uses that email. Ask them to sign up first.", 404);
          if (target.is_super_admin) return jsonError("That person is already a super admin.", 409);
          const { error } = await supabase.from("profiles").update({ is_super_admin: true }).eq("id", target.id);
          if (error) return jsonError("We couldn't save that. Please try again.", 500);
          if (platformOrg)
            await logServerActivity(supabase, platformOrg, user.id, "super_admin_granted", { target_user_id: target.id }).catch(() => undefined);
          const mail = await sendEmail({
            to: email,
            subject: "You're now an AiDwar super admin",
            body: `${actorName} gave you super admin access to AiDwar. You can now open the admin area at https://aidwar.in/admin.`,
          });
          return Response.json({ admins: await list(), me: user.id, emailed: mail.ok, email_error: mail.error ?? null });
        }

        if (body.action === "revoke") {
          const targetId = String(body.user_id ?? "");
          if (!targetId) return jsonError("Pick someone to remove.", 400);
          if (targetId === user.id) return jsonError("You can't remove yourself. Ask another super admin.", 400);
          const current = await list();
          const target = current.find((a) => a.id === targetId);
          if (!target) return jsonError("That person isn't a super admin.", 404);
          if (current.length <= 1) return jsonError("There must always be at least one super admin.", 400);
          const { error } = await supabase.from("profiles").update({ is_super_admin: false }).eq("id", targetId);
          if (error) return jsonError("We couldn't save that. Please try again.", 500);
          if (platformOrg)
            await logServerActivity(supabase, platformOrg, user.id, "super_admin_revoked", { target_user_id: targetId }).catch(() => undefined);
          let emailed = false;
          let emailError: string | null = "no_email_on_account";
          if (target.email) {
            const mail = await sendEmail({
              to: target.email,
              subject: "Your AiDwar super admin access was removed",
              body: `${actorName} removed your super admin access to AiDwar. Your own workspaces are not affected.`,
            });
            emailed = mail.ok;
            emailError = mail.error ?? null;
          }
          return Response.json({ admins: await list(), me: user.id, emailed, email_error: emailError });
        }

        return jsonError("Unknown action.", 400);
      },
    },
  },
});
