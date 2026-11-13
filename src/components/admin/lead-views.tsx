import { cn } from "@/lib/utils";
import {
  BUSINESS_TYPES,
  ENQUIRY_BANDS,
  LEAD_STATUSES,
  NO_ANSWER,
  PRIMARY_NEEDS,
  isStartLead,
  labelFor,
  leadAnswer,
  leadContact,
  leadTime,
  leadTitle,
  type LeadRow,
  type LeadStatus,
} from "@/lib/leads";

/**
 * Super Admin > Leads & Demos: the list table and the lead's summary in the
 * side sheet, as plain components (moved out of routes/admin/leads.tsx so
 * they can be rendered in tests). Batch 72: every qualification field may be
 * missing (a /start lead has only a number, maybe a name) and reads "—"; a
 * /start lead carries a "From /start" badge.
 */

const STATUS_CLASS: Record<LeadStatus, string> = {
  new: "bg-primary/10 text-primary",
  contacted: "bg-amber-50 text-amber-800",
  qualified: "bg-sky-50 text-sky-800",
  demo_booked: "bg-violet-50 text-violet-800",
  won: "bg-emerald-50 text-emerald-800",
  lost: "bg-muted text-muted-foreground",
};

/** Batch 72: a lead from the /start ad page — a number (and maybe a name), no answers. */
export function StartBadge() {
  return (
    <span className="ml-2 rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-800">
      From /start
    </span>
  );
}

/** Batch 75: the one "finish sign-up" WhatsApp reminder went to this lead. */
export function RemindedBadge() {
  return (
    <span
      className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-800"
      data-testid="reminded-badge"
    >
      Reminded ✓
    </span>
  );
}

/** Batch 78: a /start lead proved its number on WhatsApp — or hasn't (yet). */
export function VerifiedBadge({ verified }: { verified: boolean }) {
  return verified ? (
    <span
      className="ml-2 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-800"
      data-testid="verified-badge"
    >
      Verified ✓
    </span>
  ) : (
    <span
      className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800"
      data-testid="not-verified-badge"
    >
      Not verified
    </span>
  );
}

export function LeadsTable({ leads, onOpen }: { leads: LeadRow[]; onOpen: (id: string) => void }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-border bg-card">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-4 py-3 font-medium">Business</th>
            <th className="px-4 py-3 font-medium">Business name</th>
            <th className="px-4 py-3 font-medium">Needs</th>
            <th className="px-4 py-3 font-medium">Enquiries/day</th>
            <th className="px-4 py-3 font-medium">Sells</th>
            <th className="px-4 py-3 font-medium">Customers</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">Received</th>
          </tr>
        </thead>
        <tbody>
          {leads.map((lead) => (
            <tr
              key={lead.id}
              tabIndex={0}
              onClick={() => onOpen(lead.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpen(lead.id);
                }
              }}
              className="cursor-pointer border-t border-border/70 transition-colors hover:bg-muted/40 focus:bg-muted/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <td className="px-4 py-3">
                <p className="font-medium text-foreground">
                  {leadTitle(lead)}
                  {isStartLead(lead) ? <StartBadge /> : null}
                  {isStartLead(lead) ? <VerifiedBadge verified={Boolean(lead.verified_at)} /> : null}
                  {lead.nudged_at ? <RemindedBadge /> : null}
                  {lead.is_test ? (
                    <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
                      QA
                    </span>
                  ) : null}
                </p>
                <p className="text-xs text-muted-foreground">{leadContact(lead)}</p>
              </td>
              <td className="px-4 py-3 text-muted-foreground" data-testid="lead-business">
                {lead.business_name?.trim() || NO_ANSWER}
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {labelFor(PRIMARY_NEEDS, lead.primary_need)}
              </td>
              <td className="px-4 py-3 text-muted-foreground">{lead.enquiry_band ?? NO_ANSWER}</td>
              <td className="px-4 py-3 text-muted-foreground" data-testid="lead-sells">
                {leadAnswer(lead, "sells")}
              </td>
              <td className="px-4 py-3 text-muted-foreground" data-testid="lead-customers">
                {leadAnswer(lead, "customers")}
              </td>
              <td className="px-4 py-3">
                <span
                  className={cn(
                    "rounded-full px-2.5 py-1 text-xs font-medium",
                    STATUS_CLASS[lead.status],
                  )}
                >
                  {labelFor(LEAD_STATUSES, lead.status)}
                </span>
              </td>
              <td className="px-4 py-3 text-muted-foreground">{leadTime(lead.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-foreground">{value}</dd>
    </div>
  );
}

/** The sheet's contact line and details, under its title. */
export function LeadSummary({ lead }: { lead: LeadRow }) {
  return (
    <>
      <p className="mt-1 text-sm text-muted-foreground">
        {leadContact(lead)}
        {lead.website ? (
          <>
            {" · "}
            <a
              className="underline underline-offset-2"
              href={lead.website}
              target="_blank"
              rel="noreferrer noopener"
            >
              website
            </a>
          </>
        ) : null}
      </p>

      <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
        <Detail label="Business name" value={lead.business_name?.trim() || NO_ANSWER} />
        <Detail
          label="WhatsApp verified"
          value={lead.verified_at ? `Verified ✓ ${leadTime(lead.verified_at)}` : "Not verified"}
        />
        <Detail label="Business type" value={labelFor(BUSINESS_TYPES, lead.business_type)} />
        <Detail label="Enquiries a day" value={labelFor(ENQUIRY_BANDS, lead.enquiry_band)} />
        <Detail label="Sells" value={leadAnswer(lead, "sells")} />
        <Detail label="Customers" value={leadAnswer(lead, "customers")} />
        <Detail
          label="WhatsApp reminder"
          value={lead.nudged_at ? `Reminded ✓ ${leadTime(lead.nudged_at)}` : NO_ANSWER}
        />
        <Detail label="Main need" value={labelFor(PRIMARY_NEEDS, lead.primary_need)} />
        <Detail label="Received" value={leadTime(lead.created_at)} />
        <Detail label="Page" value={lead.landing_path ?? "—"} />
        <Detail label="Came from" value={lead.referrer_host ?? "direct"} />
        <Detail
          label="Campaign"
          value={
            [
              lead.first_attribution?.["utm_source"],
              lead.first_attribution?.["utm_medium"],
              lead.first_attribution?.["utm_campaign"],
            ]
              .filter(Boolean)
              .join(" / ") || "—"
          }
        />
        <Detail
          label="Permission"
          value={`Given ${leadTime(lead.consent_at)} (v${lead.consent_version})`}
        />
        <Detail
          label="Workspace"
          value={lead.organization_id ? "Linked to a signed-up workspace" : "Not linked"}
        />
      </dl>
    </>
  );
}
