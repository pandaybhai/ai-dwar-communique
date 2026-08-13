import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { aidwar } from "@/integrations/aidwar/client";

export const Route = createFileRoute("/app")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await aidwar.auth.getUser();
    if (error || !data.user) {
      throw redirect({ to: "/login" });
    }
    return { user: data.user };
  },
  component: () => <Outlet />,
});
