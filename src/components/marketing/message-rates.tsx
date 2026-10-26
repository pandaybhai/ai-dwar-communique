import type { ClientRate, MessageCategory } from "@/lib/billing";

const LABELS: Record<MessageCategory, string> = {
  marketing: "Marketing",
  utility: "Utility",
  authentication: "Authentication",
  service: "Service replies inside the 24-hour window",
};

const ORDER: MessageCategory[] = ["marketing", "utility", "authentication", "service"];

function perMessage(rate: number, currency: string): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: currency || "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(rate);
}

/** "Message credit rates (India)": the platform default client rate per category. */
export function MessageRatesTable({ rates }: { rates: ClientRate[] }) {
  const byCategory = new Map(rates.map((r) => [r.category, r]));
  return (
    <div className="mt-10">
      <h3 className="font-heading text-lg font-bold text-foreground">
        Message credit rates (India)
      </h3>
      {rates.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          We couldn't load the rates just now. Your exact rate is always shown in Billing before you
          send.
        </p>
      ) : (
        <div className="mt-4 overflow-hidden rounded-xl border border-border bg-background">
          <table className="w-full text-left text-sm">
            <thead className="bg-secondary/60 text-foreground">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">
                  Message type
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Rate per message (INR)
                </th>
              </tr>
            </thead>
            <tbody>
              {ORDER.map((category) => {
                const row = byCategory.get(category);
                return (
                  <tr key={category} className="border-t border-border">
                    <td className="px-4 py-3 text-foreground">{LABELS[category]}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-foreground">
                      {row && row.rate !== null ? perMessage(row.rate, row.currency) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {rates.length === 0 ? null : (
        <p className="mt-3 text-xs text-muted-foreground">
          Rates follow Meta's prices and may change; your exact rate is shown before every send.
        </p>
      )}
    </div>
  );
}
