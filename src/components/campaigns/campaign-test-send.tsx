import { useEffect, useState } from "react";
import { FlaskConical, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { callApi } from "@/lib/whatsapp-client";
import { money, rateMoney } from "@/lib/billing";
import {
  MAX_TEST_NUMBERS,
  MAX_TESTS_PER_CAMPAIGN,
  parseTestNumbers,
  type VariableMappings,
} from "@/lib/campaigns";

type Quote = {
  enabled: boolean;
  currency: string;
  perNumber: Array<{ phone: string; rate: number }>;
  total: number;
  available: number;
  covers: boolean;
};

type Answer = {
  quote: Quote;
  used: number;
  remaining: number;
  results?: Array<{ phone: string; sent: boolean; error: string | null }>;
};

/**
 * Batch 35: "Send a test" on the campaign's Review step. The campaign's exact
 * template, variables and files go to 1–5 numbers, charged like any send; the
 * cost shows before anything is sent.
 */
export function CampaignTestSend({
  organizationId,
  testRef,
  templateName,
  accountId,
  mappings,
  sendSettings,
}: {
  organizationId: string;
  /** Made when the wizard opens: the campaign-to-be the 20-test limit counts against. */
  testRef: string;
  templateName: string;
  accountId: string;
  mappings: VariableMappings;
  sendSettings: Record<string, unknown>;
}) {
  const [numbers, setNumbers] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const parsed = parseTestNumbers(numbers);

  const body = (action: "quote" | "send") => ({
    organization_id: organizationId,
    action,
    test_ref: testRef,
    numbers,
    template_name: templateName,
    whatsapp_account_id: accountId || null,
    variable_mappings: mappings,
    send_settings: sendSettings,
  });

  // The cost of this test, before anything is sent.
  useEffect(() => {
    if (!numbers.trim() || parsed.error) {
      setAnswer(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      void (async () => {
        const { data, error } = await callApi<Answer>("/api/campaigns/test-send", {
          body: body("quote"),
        });
        if (cancelled) return;
        setAnswer(data);
        setProblem(data ? null : error);
      })();
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numbers, parsed.error, templateName, accountId]);

  const send = async () => {
    setSending(true);
    const { data, error } = await callApi<Answer>("/api/campaigns/test-send", {
      body: body("send"),
    });
    setSending(false);
    if (!data) {
      setProblem(error);
      toast.error(error ?? "We couldn't send the test.");
      return;
    }
    setAnswer(data);
    setProblem(null);
    const failed = (data.results ?? []).filter((r) => !r.sent);
    if (failed.length === 0) toast.success("Test sent — check your WhatsApp.");
    else toast.error(`${failed.length} test${failed.length === 1 ? "" : "s"} didn't go out.`);
  };

  const quote = answer?.quote ?? null;
  const remaining = answer?.remaining ?? MAX_TESTS_PER_CAMPAIGN;

  return (
    <div
      className="space-y-3 rounded-2xl border border-border/70 bg-card p-4"
      data-testid="campaign-test-send"
    >
      <div className="flex items-start gap-2">
        <FlaskConical className="mt-0.5 h-4 w-4 text-primary" aria-hidden="true" />
        <div>
          <p className="text-sm font-medium">Send a test</p>
          <p className="text-xs text-muted-foreground">
            The exact message this campaign sends, to up to {MAX_TEST_NUMBERS} numbers. It's charged
            like any message and isn't counted in the campaign's results.
          </p>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="campaign-test-numbers" className="text-xs">
          Phone numbers (with country code, one per line or separated by commas)
        </Label>
        <Textarea
          id="campaign-test-numbers"
          value={numbers}
          onChange={(e) => setNumbers(e.target.value)}
          rows={2}
          placeholder="+91 98765 43210"
          className="resize-none rounded-xl"
        />
        {numbers.trim() && parsed.error ? (
          <p className="text-xs text-destructive">{parsed.error}</p>
        ) : null}
        {problem ? <p className="text-xs text-destructive">{problem}</p> : null}
      </div>
      {quote ? (
        <p className="text-xs text-muted-foreground" data-testid="campaign-test-cost">
          {quote.enabled
            ? `${rateMoney(quote.perNumber[0]?.rate ?? 0, quote.currency)} per message · this test costs about ${money(quote.total, quote.currency)}`
            : "Billing is off for this workspace, so the test isn't charged."}
          {` · ${remaining} of ${MAX_TESTS_PER_CAMPAIGN} tests left`}
        </p>
      ) : null}
      {answer?.results?.length ? (
        <ul className="space-y-0.5 text-xs">
          {answer.results.map((r) => (
            <li key={r.phone} className={r.sent ? "text-emerald-600" : "text-destructive"}>
              {r.phone}: {r.sent ? "sent" : (r.error ?? "not sent")}
            </li>
          ))}
        </ul>
      ) : null}
      <Button
        size="sm"
        variant="outline"
        className="rounded-full"
        disabled={
          sending ||
          Boolean(parsed.error) ||
          !templateName ||
          remaining < parsed.numbers.length ||
          (quote ? quote.enabled && !quote.covers : false)
        }
        onClick={() => void send()}
      >
        {sending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
        Send test
      </Button>
    </div>
  );
}
