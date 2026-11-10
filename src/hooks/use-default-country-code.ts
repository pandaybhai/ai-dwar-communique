import { useEffect, useState } from "react";
import { aidwar } from "@/integrations/aidwar/client";
import { loadDefaultCountryCode } from "@/lib/default-country";

/**
 * Batch 66: the workspace's default country code (organizations.default_country_code,
 * "91" until 20261360 is applied), read once with the member's own client —
 * the import preview, Add contact, the copy-numbers card and Settings > Workspace.
 * `code` null while loading or when it couldn't be read (`error` says so).
 */
export function useDefaultCountryCode(organizationId: string | null | undefined): {
  code: string | null;
  error: string | null;
  loading: boolean;
} {
  const [state, setState] = useState<{
    code: string | null;
    error: string | null;
    loading: boolean;
  }>({ code: null, error: null, loading: Boolean(organizationId) });
  useEffect(() => {
    if (!organizationId) return;
    let live = true;
    setState({ code: null, error: null, loading: true });
    void loadDefaultCountryCode(aidwar, organizationId).then((read) => {
      if (!live) return;
      setState(
        "code" in read
          ? { code: read.code, error: null, loading: false }
          : { code: null, error: read.error, loading: false },
      );
    });
    return () => {
      live = false;
    };
  }, [organizationId]);
  return state;
}
