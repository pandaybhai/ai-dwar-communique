import { createServerFn } from "@tanstack/react-start";
import type { PublicPlan } from "./public-plans.server";

export type { PublicPlan };

/** Public plans for server-rendered marketing pages. Never throws: [] on failure. */
export const getPublicPlans = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { loadPublicPlans } = await import("./public-plans.server");
    return { plans: await loadPublicPlans(), ok: true as const };
  } catch {
    return { plans: [] as PublicPlan[], ok: false as const };
  }
});
