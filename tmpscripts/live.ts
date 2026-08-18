import { createClient } from "@supabase/supabase-js";
import { loadSenderContext, sendCampaignTemplate } from "@/lib/campaigns.server";

const url = process.env["AIDWAR_SUPABASE_URL"]!;
const key = process.env["AIDWAR_SUPABASE_SERVICE_ROLE_KEY"]!;
const supabase = createClient(url, key, { auth: { persistSession: false } });
const ORG = "acdb837c-92e9-4791-a13b-275856777f59";
const ACCOUNT = "9973f1b2-5fbf-4f51-96fd-9a7aa49583a6";
const TO = "+917981223192";

const sender = await loadSenderContext(supabase, ORG, ACCOUNT);
if (!sender) throw new Error("no sender");

const { data: tpls } = await supabase.from("message_templates").select("name,language,components")
  .eq("organization_id", ORG).like("name", "parity_%");
const byName = Object.fromEntries((tpls ?? []).map((t: any) => [t.name.split("_").slice(0,3).join("_"), t]));
const pick = (p: string) => (tpls ?? []).find((t: any) => t.name.startsWith(p))!;

const IMG = "https://picsum.photos/seed/aidwar1/800/450";
const IMG2 = "https://picsum.photos/seed/aidwar2/800/450";

const cases: Array<[string, any, any]> = [
  ["text header + URL/phone/quick reply", pick("parity_text_mix"),
    { campaignId: null, category: "marketing", linkTarget: "https://aidwar.in/track/1010" }],
  ["image header + copy code", pick("parity_image_coupon"),
    { campaignId: null, category: "marketing", couponCode: "SAVE20",
      headerMediaUrl: IMG }],
  ["carousel, 2 cards", pick("parity_carousel"),
    { campaignId: null, category: "marketing",
      cards: [
        { mediaUrl: IMG, values: { "1": "Cotton kurta" }, linkTarget: "https://aidwar.in/p/111" },
        { mediaUrl: IMG2, values: { "1": "Silk dupatta" }, linkTarget: "https://aidwar.in/p/222" },
      ] }],
];

for (const [label, tpl, ctx] of cases) {
  const out = await sendCampaignTemplate(supabase, ORG, sender,
    { contactId: null, phone: TO, variables: { "1": "Asha" } },
    { name: tpl.name, language: tpl.language, variableOrder: [1], components: tpl.components },
    ctx);
  console.log(label, "|", tpl.name, "|", out.error ? "FAIL: " + out.error : "sent " + out.messageId);
  if (out.error && out.messageId) {
    const { data } = await supabase.from("messages").select("error_detail").eq("id", out.messageId).single();
    console.log("   detail:", JSON.stringify(data?.error_detail).slice(0, 400));
  }
}
