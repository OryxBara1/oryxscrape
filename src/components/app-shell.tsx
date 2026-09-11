import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { Activity, Boxes, Database, Globe2, ScrollText, LogOut } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { supabase } from "@/integrations/supabase/client";

/**
 * TEMPORARY SHELL.
 * The final chrome must come from the 21st.dev `dashboard-sidebar` registry
 * component. That registry currently returns 401 for anonymous installs, so
 * this minimal token-driven shell holds the navigation until an API key is
 * available. No stock shadcn Card/Button/Badge/Table is used here.
 */

const NAV = [
  { to: "/dashboard", label: "Dashboard", icon: Activity },
  { to: "/sources", label: "Sources", icon: Globe2 },
  { to: "/jobs", label: "Collection jobs", icon: Boxes },
  { to: "/items", label: "Collected items", icon: Database },
  { to: "/audit", label: "Audit log", icon: ScrollText },
] as const;

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

  return (
    <div className="flex min-h-screen w-full">
      <aside className="glass-panel m-3 hidden w-60 flex-col rounded-2xl p-4 md:flex">
        <div className="px-2 py-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.32em] text-primary">OryxBara</p>
          <p className="glow-text text-lg font-semibold tracking-tight">OryxScrape</p>
        </div>

        <nav className="mt-4 flex flex-1 flex-col gap-1">
          {NAV.map((item) => {
            const active = pathname === item.to;
            return (
              <Link
                key={item.to}
                to={item.to}
                className={[
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition",
                  active
                    ? "bg-primary/12 text-foreground shadow-glow"
                    : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
                ].join(" ")}
              >
                <item.icon className="h-4 w-4" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <button
          type="button"
          onClick={signOut}
          className="mt-4 flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition hover:bg-white/5 hover:text-foreground"
        >
          <LogOut className="h-4 w-4" />
          <span>Sign out</span>
        </button>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 overflow-x-auto px-4 py-3 md:hidden">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={[
                "whitespace-nowrap rounded-full border px-3 py-1.5 text-xs transition",
                pathname === item.to
                  ? "border-primary/40 text-foreground shadow-glow"
                  : "border-border text-muted-foreground",
              ].join(" ")}
            >
              {item.label}
            </Link>
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
          Awaiting registry components
        </p>
      </div>
    </section>
  );
}
