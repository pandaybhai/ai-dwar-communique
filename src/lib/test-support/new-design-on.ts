/**
 * Batch 44: runs the whole suite as a workspace with `new_design` ON
 * (`bun run test:new-design`, also a CI step). The switch is forced on, and
 * every page renders inside a new-shell section (Campaigns, with its three
 * sub-tabs) so PageHeader and the pages that read the shell take their
 * new-design branch. The flag-OFF run is the plain `bun run test`.
 */
import { vi } from "vitest";
import { createContext, useContext } from "react";

vi.mock("@/lib/new-design", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/new-design")>()),
  useNewDesign: () => true,
}));

vi.mock("@/components/shell/section-tabs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/shell/section-tabs")>();
  const { Megaphone } = await import("lucide-react");
  const tabs = [
    { key: "/app/campaigns", to: "/app/campaigns", label: "Campaigns" },
    { key: "/app/templates", to: "/app/templates", label: "Templates" },
    { key: "/app/cards", to: "/app/cards", label: "Cards" },
  ];
  const state = {
    section: {
      key: "campaigns" as const,
      label: "Campaigns",
      icon: Megaphone,
      to: "/app/campaigns",
      tabs,
      owns: [],
    },
    activeTab: tabs[0]!,
    counts: {},
  };
  // A provider in a test still wins; otherwise every page is "inside" Campaigns.
  const Fallback = createContext(state);
  return {
    ...actual,
    useShellSection: () => {
      const provided = useContext(actual.ShellSectionContext);
      const fallback = useContext(Fallback);
      return provided ?? fallback;
    },
  };
});
