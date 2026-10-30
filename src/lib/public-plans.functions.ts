import { createServerFn } from "@tanstack/react-start";
import type { PublicPlan } from "./public-plans.server";

export type { PublicPlan };

/** Public plans for server-rendered marketing pages. Never throws: [] on failure. */
export const getPublicPlans = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { loadPublicPlans, loadPublicGstRegistered } = await import("./public-plans.server");
    const [plans, gstRegistered] = await Promise.all([
      loadPublicPlans(),
      loadPublicGstRegistered(),
    ]);
    return { plans, ok: true as const, gst_registered: gstRegistered };
  } catch {
    return { plans: [] as PublicPlan[], ok: false as const, gst_registered: false };
  }
});

/** Batch 55: whether AiDwar charges GST right now (false on any failure). */
export const getPublicGstMode = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { loadPublicGstRegistered } = await import("./public-plans.server");
    return { gst_registered: await loadPublicGstRegistered() };
  } catch {
    return { gst_registered: false };
  }
});
