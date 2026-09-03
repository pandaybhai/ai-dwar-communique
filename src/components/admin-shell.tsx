import { useState, type ReactNode } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  Bot,
  Building2,
  CreditCard,
  Flag,
  LogOut,
  Menu,
  ShieldCheck,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { aidwar } from "@/integrations/aidwar/client";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/admin/organizations", label: "Organizations", icon: Building2 },
  { to: "/admin/billing", label: "Billing", icon: CreditCard },
  { to: "/admin/users", label: "Users", icon: Users },
  { to: "/admin/flags", label: "Feature Flags", icon: Flag },
  { to: "/admin/ai", label: "AI operations", icon: Bot },
  { to: "/admin/activity", label: "Activity", icon: Activity },
] as const;

function AdminNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav className="space-y-1">
      {NAV.map((item) => {
        const isActive = pathname === item.to || pathname.startsWith(`${item.to}/`);
        return (
          <Link
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200",
              isActive
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function AdminShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  async function signOut() {
    await aidwar.auth.signOut();
    navigate({ to: "/login", replace: true });
  }

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/90 backdrop-blur">
        <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 p-6">
              <SheetTitle className="mb-6 text-left">Super Admin</SheetTitle>
              <AdminNav onNavigate={() => setOpen(false)} />
            </SheetContent>
          </Sheet>

          <span className="text-xl font-bold tracking-tight text-foreground">
            Ai<span className="text-primary">Dwar</span>
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">
            <ShieldCheck className="h-3.5 w-3.5" /> Super Admin
          </span>

          <div className="ml-auto flex items-center gap-2">
            <Button asChild variant="outline" size="sm" className="rounded-full">
              <Link to="/app/inbox">Back to workspace</Link>
            </Button>
            <Button variant="ghost" size="sm" className="rounded-full" onClick={signOut}>
              <LogOut className="mr-2 h-4 w-4" /> Log out
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1500px]">
        <aside className="hidden w-64 shrink-0 border-r border-border/70 bg-background px-4 py-6 lg:block">
          <AdminNav />
        </aside>
        <main className="min-w-0 flex-1 px-4 py-8 sm:px-6 lg:px-10">{children}</main>
      </div>
    </div>
  );
}
