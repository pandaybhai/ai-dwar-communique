import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { aidwar } from "@/integrations/aidwar/client";

export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const { data: sub } = aidwar.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setLoading(false);
    });
    aidwar.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return { session, user: session?.user ?? null, loading };
}
