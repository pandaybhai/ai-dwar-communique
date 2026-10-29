import { useCallback, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { employeeApi } from "@/lib/employee-client";
import type { HomeMode } from "@/lib/new-home";

/**
 * Batch 45: Aiden's Off / Draft / Replying switch for Home. The same server
 * call as the Employee page's switch (/api/ai/employee action "set_mode",
 * which needs ai.configure and goes to setAgentMode): Replying first asks for
 * a test unless skipped, and a refusal for plan or credits says why and offers
 * Billing. `onChanged` runs after a saved change.
 */
export function useAidenModeSwitch(
  organizationId: string | null,
  onChanged: (mode: HomeMode) => void,
) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState<HomeMode | null>(null);
  const [gate, setGate] = useState<{ mode: HomeMode; message: string } | null>(null);

  const setMode = useCallback(
    async (mode: HomeMode, skipTest = false) => {
      if (!organizationId || busy) return;
      setBusy(mode);
      const { error, raw } = await employeeApi({
        organization_id: organizationId,
        action: "set_mode",
        mode,
        ...(skipTest ? { skip_test: true } : {}),
      });
      setBusy(null);
      if ((raw as { needs_test?: boolean } | null)?.needs_test) {
        setGate({ mode, message: (raw as { message: string }).message });
        return;
      }
      if (error) {
        if ((raw as { billing?: boolean } | null)?.billing === true) {
          toast.error(error, {
            action: {
              label: "Go to billing",
              onClick: () => void navigate({ to: "/app/billing" }),
            },
          });
        } else toast.error(error);
        return;
      }
      toast.success("Saved.");
      onChanged(mode);
    },
    [organizationId, busy, navigate, onChanged],
  );

  return { setMode, busy, gate, closeGate: () => setGate(null) };
}
