import { getServiceClient } from "@/lib/whatsapp-webhook.server";
import { issuePendingInvoices } from "@/lib/invoices.server";
const s = getServiceClient();
console.log(JSON.stringify(await issuePendingInvoices(s), null, 2));
const { data } = await s.from("invoices").select("invoice_number, status, pdf_path, pdf_error, sent").not("invoice_number","is",null).neq("status","void");
console.log((data ?? []).map((r:any)=>[r.invoice_number, r.pdf_path?"pdf":"NO-PDF", r.pdf_error??"-", r.sent?.whatsapp_error ?? "-", r.sent?.whatsapp_at?"sent":"-"].join(" | ")).join("\n"));
