import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, RotateCcw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { callApi } from "@/lib/whatsapp-client";
import {
  ConnectProgress,
  type ConnectStepKey,
  type StepStates,
} from "@/components/whatsapp-connect-progress";

type EsConfig = { app_id: string; config_id: string; graph_version: string; available: boolean };

type SessionInfo = { waba_id?: string; phone_number_id?: string };

type ExchangeResult = {
  warnings?: string[];
  subscribe_error?: string | null;
  register_error?: string | null;
  reprocessed_events?: number;
  registered?: boolean;
  subscribed?: boolean;
};

declare global {
  interface Window {
    FB?: {
      init: (options: Record<string, unknown>) => void;
      login: (
        cb: (response: { authResponse?: { code?: string } | null; status?: string }) => void,
        options: Record<string, unknown>,
      ) => void;
    };
  }
}

const SDK_ID = "facebook-jssdk";

function loadSdk(appId: string, version: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.FB) {
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve();
      return;
    }
    const existing = document.getElementById(SDK_ID) as HTMLScriptElement | null;
    const script = existing ?? document.createElement("script");
    script.id = SDK_ID;
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.onload = () => {
      if (!window.FB) {
        reject(new Error("sdk"));
        return;
      }
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve();
    };
    script.onerror = () => reject(new Error("sdk"));
    if (!existing) document.body.appendChild(script);
  });
}

/**
 * Meta Embedded Signup. Meta posts the WABA and phone number ids back through
 * a window message; the one-time code arrives in the FB.login callback. Both
 * halves are needed before we can hand anything to our server. Every stage is
 * surfaced to the user so a failure is never a silent dead end.
 */
export function EmbeddedSignupButton({
  orgId,
  onConnected,
}: {
  orgId: string;
  onConnected: () => Promise<void>;
}) {
  const [config, setConfig] = useState<EsConfig | null>(null);
  const [working, setWorking] = useState(false);
  const [started, setStarted] = useState(false);
  const [steps, setSteps] = useState<StepStates>({});
  const [notes, setNotes] = useState<Partial<Record<ConnectStepKey, string>>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const sessionRef = useRef<SessionInfo>({});

  const mark = useCallback((key: ConnectStepKey, state: StepStates[ConnectStepKey], note?: string) => {
    setSteps((prev) => ({ ...prev, [key]: state }));
    if (note !== undefined) setNotes((prev) => ({ ...prev, [key]: note }));
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/whatsapp/es-config");
        const body = (await res.json()) as EsConfig;
        if (alive) setConfig(body);
      } catch {
        if (alive) setConfig({ app_id: "", config_id: "", graph_version: "v25.0", available: false });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!/^https:\/\/(www\.)?facebook\.com$/.test(event.origin)) return;
      try {
        const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (!data || data.type !== "WA_EMBEDDED_SIGNUP") return;
        if (data.event === "FINISH" || data.event === "FINISH_ONLY_WABA") {
          sessionRef.current = {
            waba_id: data.data?.waba_id,
            phone_number_id: data.data?.phone_number_id,
          };
        }
        if (data.event === "CANCEL") {
          sessionRef.current = {};
        }
      } catch {
        // Meta also posts unrelated messages — ignore anything we can't read.
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const fail = useCallback(
    (key: ConnectStepKey, message: string) => {
      setWorking(false);
      mark(key, "error", message);
      setBanner(message);
      toast.error(message);
    },
    [mark],
  );

  const finish = useCallback(
    async (code: string) => {
      const { waba_id, phone_number_id } = sessionRef.current;
      if (!waba_id || !phone_number_id) {
        fail("code_received", "Meta didn't send the account details. Please run the flow again.");
        return;
      }
      mark("code_received", "done", "Account details received from Meta.");
      mark("token_exchanged", "active");

      const { data, error, raw } = await callApi<ExchangeResult>("/api/whatsapp/es-exchange", {
        body: { organization_id: orgId, code, waba_id, phone_number_id },
      });
      sessionRef.current = {};

      if (error) {
        const step =
          ((raw as Record<string, unknown> | null)?.["step"] as ConnectStepKey | undefined) ??
          "token_exchanged";
        fail(step, error);
        return;
      }

      setWorking(false);
      mark("token_exchanged", "done", "Secure business token stored on our servers.");
      mark(
        "waba_subscribed",
        data?.subscribe_error ? "warning" : "done",
        data?.subscribe_error ?? "Incoming messages will now reach your inbox.",
      );
      mark(
        "phone_registered",
        data?.register_error ? "warning" : "done",
        data?.register_error ?? (data?.registered ? "Number activated for sending." : "Registration requested."),
      );
      mark(
        "events_reprocessed",
        "done",
        `${data?.reprocessed_events ?? 0} pending event${data?.reprocessed_events === 1 ? "" : "s"} replayed.`,
      );

      if (data?.subscribe_error || data?.register_error) {
        setBanner(
          "Your number is connected, but Meta didn't finish every step. You can retry the connection or contact support.",
        );
      }
      toast.success("WhatsApp connected");
      await onConnected();
    },
    [orgId, onConnected, fail, mark],
  );

  async function start() {
    if (!config?.available) return;
    setWorking(true);
    setStarted(true);
    setBanner(null);
    setNotes({});
    setSteps({ popup_opened: "active" });
    sessionRef.current = {};
    try {
      await loadSdk(config.app_id, config.graph_version);
    } catch {
      fail(
        "popup_opened",
        "We couldn't load the Facebook sign-up window. Check your connection and retry.",
      );
      return;
    }

    mark("popup_opened", "done", "Complete the steps in the Facebook window.");
    mark("code_received", "active");

    window.FB!.login(
      (response) => {
        const code = response?.authResponse?.code;
        if (!code) {
          fail("code_received", "Sign-up was cancelled before it finished. You can start again anytime.");
          return;
        }
        void finish(code);
      },
      {
        config_id: config.config_id,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {}, featureType: "", sessionInfoVersion: 3 },
      },
    );
  }

  if (config && !config.available) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        Sign-up with Facebook isn't switched on for this workspace yet. Use the manual option below,
        or contact support.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Button
        size="lg"
        className="h-14 w-full rounded-2xl bg-gradient-to-r from-primary to-teal-500 text-base font-semibold shadow-lg shadow-primary/20 transition-all duration-200 hover:shadow-xl hover:shadow-primary/25 active:scale-[0.99] sm:w-auto sm:px-8"
        onClick={() => void start()}
        disabled={!config || working}
      >
        {working ? (
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        ) : started ? (
          <RotateCcw className="mr-2 h-5 w-5" />
        ) : (
          <svg viewBox="0 0 24 24" className="mr-2 h-5 w-5 fill-current" aria-hidden="true">
            <path d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.96h-1.51c-1.49 0-1.96.93-1.96 1.89v2.26h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07z" />
          </svg>
        )}
        {working
          ? "Waiting for Facebook…"
          : started
            ? "Try connecting again"
            : "Connect WhatsApp with Facebook"}
      </Button>

      <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5 text-primary" />
        Official Meta sign-up. We never see your Facebook password.
      </p>

      {banner ? (
        <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <p className="text-sm text-destructive">{banner}</p>
        </div>
      ) : null}

      {started ? (
        <div className="rounded-xl border border-border/70 bg-muted/20 p-5">
          <p className="mb-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Connection progress
          </p>
          <ConnectProgress states={steps} notes={notes} />
        </div>
      ) : null}
    </div>
  );
}
