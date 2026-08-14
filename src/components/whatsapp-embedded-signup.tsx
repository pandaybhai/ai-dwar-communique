import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { callApi } from "@/lib/whatsapp-client";

type EsConfig = { app_id: string; config_id: string; graph_version: string; available: boolean };

type SessionInfo = { waba_id?: string; phone_number_id?: string };

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
 * halves are needed before we can hand anything to our server.
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
  const sessionRef = useRef<SessionInfo>({});

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

  const finish = useCallback(
    async (code: string) => {
      const { waba_id, phone_number_id } = sessionRef.current;
      if (!waba_id || !phone_number_id) {
        setWorking(false);
        toast.error("Meta didn't send the account details. Please run the flow again.");
        return;
      }
      const { data, error } = await callApi<{ warnings?: string[] }>(
        "/api/whatsapp/es-exchange",
        { body: { organization_id: orgId, code, waba_id, phone_number_id } },
      );
      setWorking(false);
      sessionRef.current = {};
      if (error) {
        toast.error(error);
        return;
      }
      for (const w of data?.warnings ?? []) toast.warning(w);
      toast.success("WhatsApp connected");
      await onConnected();
    },
    [orgId, onConnected],
  );

  async function start() {
    if (!config?.available) return;
    setWorking(true);
    sessionRef.current = {};
    try {
      await loadSdk(config.app_id, config.graph_version);
    } catch {
      setWorking(false);
      toast.error("We couldn't load the Facebook sign-up window. Check your connection and retry.");
      return;
    }

    window.FB!.login(
      (response) => {
        const code = response?.authResponse?.code;
        if (!code) {
          setWorking(false);
          toast.error("Sign-up was cancelled before it finished. You can start again anytime.");
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
    <div className="space-y-3">
      <Button
        size="lg"
        className="h-14 w-full rounded-2xl bg-gradient-to-r from-primary to-teal-500 text-base font-semibold shadow-lg shadow-primary/20 transition-all duration-200 hover:shadow-xl hover:shadow-primary/25 active:scale-[0.99] sm:w-auto sm:px-8"
        onClick={() => void start()}
        disabled={!config || working}
      >
        {working ? (
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
        ) : (
          <svg viewBox="0 0 24 24" className="mr-2 h-5 w-5 fill-current" aria-hidden="true">
            <path d="M24 12.07C24 5.4 18.63 0 12 0S0 5.4 0 12.07C0 18.1 4.39 23.1 10.13 24v-8.44H7.08v-3.49h3.05V9.41c0-3.02 1.79-4.69 4.53-4.69 1.31 0 2.68.24 2.68.24v2.96h-1.51c-1.49 0-1.96.93-1.96 1.89v2.26h3.33l-.53 3.49h-2.8V24C19.61 23.1 24 18.1 24 12.07z" />
          </svg>
        )}
        {working ? "Waiting for Facebook…" : "Connect WhatsApp with Facebook"}
      </Button>
      <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5 text-primary" />
        Official Meta sign-up. We never see your Facebook password.
      </p>
    </div>
  );
}
