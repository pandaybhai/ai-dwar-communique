import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env["VITE_AIDWAR_SUPABASE_URL"] as string;
const SUPABASE_ANON_KEY = import.meta.env["VITE_AIDWAR_SUPABASE_ANON_KEY"] as string;

let _client: SupabaseClient | undefined;

function create(): SupabaseClient {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("Missing AiDwar backend configuration.");
  }
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      storage: typeof window !== "undefined" ? window.localStorage : undefined,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
}

export const aidwar = new Proxy({} as SupabaseClient, {
  get(_t, prop, receiver) {
    if (!_client) _client = create();
    return Reflect.get(_client, prop, receiver);
  },
});
