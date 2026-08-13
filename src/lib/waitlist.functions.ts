import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const schema = z.object({
  name: z.string().trim().min(1).max(100),
  business: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(255),
  phone: z.string().trim().min(7).max(20),
});

export const joinWaitlist = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => schema.parse(data))
  .handler(async ({ data }) => {
    const supabase = createClient(
      process.env["AIDWAR_SUPABASE_URL"]!,
      process.env["AIDWAR_SUPABASE_ANON_KEY"]!,
      { auth: { storage: undefined, persistSession: false, autoRefreshToken: false } },
    );
    const { error } = await supabase.from("waitlist_signups").insert({
      name: data.name,
      business_name: data.business,
      email: data.email,
      phone: data.phone,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
