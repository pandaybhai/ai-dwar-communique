import { createClient } from "@supabase/supabase-js";
import { voidAndReissueInvoice } from "@/lib/invoices.server";

const supabase = createClient(
  process.env["AIDWAR_SUPABASE_URL"]!,
  process.env["AIDWAR_SUPABASE_SERVICE_ROLE_KEY"]!,
  { auth: { persistSession: false } },
);
const res = await voidAndReissueInvoice(
  supabase as never,
  "79d00034-0036-4135-ae12-cb22b4568aa3",
  "test — invalid",
);
console.log(JSON.stringify(res));
