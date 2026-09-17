import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  Boxes,
  Database,
  Globe2,
  KeyRound,
  ScrollText,
  Share2,
  BookMarked,
  LogOut,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { SidebarNav, type NavGroupData, type NavItemData } from "@/components/ui/dashboard-sidebar";
import { UsageGuide } from "@/components/usage-guide";
import { supabase } from "@/integrations/supabase/client";

const NAV: { to: string; label: string; icon: NavItemData["icon"] }[] = [
  { to: "/dashboard", label: "Dashboard", icon: Activity },
  { to: "/sources", label: "Sources", icon: Globe2 },
  { to: "/jobs", label: "Collection jobs", icon: Boxes },
  { to: "/items", label: "Collected items", icon: Database },
  { to: "/audit", label: "Audit log", icon: ScrollText },
  { to: "/exchange", label: "Exchange handoff", icon: Share2 },
  { to: "/lexicon", label: "Search lexicon", icon: BookMarked },
  { to: "/keys", label: "Consumer keys", icon: KeyRound },
];

const GROUPS: NavGroupData[] = [
  {
    heading: "Pipeline",
    items: NAV.slice(0, 5).map((n) => ({ id: n.to, title: n.label, icon: n.icon })),
  },
  {
    heading: "Delivery",
    items: NAV.slice(5).map((n) => ({ id: n.to, title: n.label, icon: n.icon })),
  },
];

const BOTTOM: NavItemData[] = [{ id: "signout", title: "Sign out", icon: LogOut }];

function Brand() {
  return (
    <div className="px-2 py-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-primary">OryxBara</p>
      <p className="glow-text text-lg font-semibold tracking-tight">OryxScrape</p>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  async function signOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  function handleSelect(id: string) {
    if (id === "signout") {
      void signOut();
      return;
    }
    navigate({ to: id });
  }

  return (
    <div className="flex min-h-screen w-full">
      <UsageGuide />
      <aside className="glass-panel m-3 hidden overflow-hidden rounded-2xl md:block">
        <SidebarNav
          className="h-full border-r-0 bg-transparent"
          groups={GROUPS}
          bottomItems={BOTTOM}
          header={<Brand />}
          activeId={pathname}
          onSelect={handleSelect}
        />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 overflow-x-auto px-4 py-3 md:hidden">
          {NAV.map((item) => (
            <button
              key={item.to}
              type="button"
              onClick={() => handleSelect(item.to)}
              className={[
                "whitespace-nowrap rounded-full border px-3 py-1.5 text-xs transition",
                pathname === item.to
                  ? "border-primary/40 text-foreground shadow-glow"
                  : "border-border text-muted-foreground",
              ].join(" ")}
            >
              {item.label}
            </button>
          ))}
        </header>

        <main className="min-w-0 flex-1 p-4 md:p-8">{children}</main>
      </div>
    </div>
  );
}

export function ScreenPlaceholder({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <section className="space-y-6">
      <header>
        <h1 className="glow-text text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </header>
      <div className="glass-panel flex min-h-52 items-center justify-center p-10">
        <p className="font-mono text-xs uppercase tracking-[0.28em] text-muted-foreground">
          Nothing here yet
        </p>
      </div>
    </section>
  );
}
