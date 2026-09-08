import { getServiceClient } from "@/lib/whatsapp-webhook.server";
import { issuePendingInvoices } from "@/lib/invoices.server";
const s = getServiceClient();
console.log(JSON.stringify(await issuePendingInvoices(s), null, 1));
