import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/auth")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Sign in — OryxScrape" },
      {
        name: "description",
        content:
          "Internal sign-in for OryxScrape, the OryxBara data-collection service. Access is invite-only.",
      },
      { property: "og:title", content: "Sign in — OryxScrape" },
      {
        property: "og:description",
        content: "Invite-only staff access to the OryxScrape collection console.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: AuthPage,
});

type Mode = "sign-in" | "set-password";

function AuthPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // An invite / recovery link lands here with the session in the URL hash.
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) return;
    const params = new URLSearchParams(hash);
    const type = params.get("type");
    if (type === "invite" || type === "recovery" || type === "signup") {
      setMode("set-password");
      setNotice(
        type === "recovery"
          ? "Choose a new password for your account."
          : "Welcome. Choose a password to activate your staff account.",
      );
    }
  }, []);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data.user && mode === "sign-in") {
        navigate({ to: "/dashboard", replace: true });
      }
    });
  }, [mode, navigate]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "set-password") {
        const { error: updateError } = await supabase.auth.updateUser({ password });
        if (updateError) throw updateError;
        window.history.replaceState(null, "", window.location.pathname);
        navigate({ to: "/dashboard", replace: true });
        return;
      }
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInError) throw signInError;
      navigate({ to: "/dashboard", replace: true });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-16">
      <div className="glass-panel glow-ring w-full max-w-sm p-8">
        <p className="font-mono text-[11px] uppercase tracking-[0.32em] text-primary">OryxBara</p>
        <h1 className="glow-text mt-2 text-2xl font-semibold tracking-tight">OryxScrape</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Internal console. Access is invite-only — there is no self sign-up.
        </p>

        {notice ? (
          <p className="mt-5 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-foreground">
            {notice}
          </p>
        ) : null}

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          {mode === "sign-in" ? (
            <div className="space-y-1.5">
              <label htmlFor="email" className="text-xs font-medium text-muted-foreground">
                Email
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="w-full rounded-lg border border-input bg-background/40 px-3 py-2 text-sm outline-none transition focus:border-primary/60 focus:shadow-glow"
              />
            </div>
          ) : null}

          <div className="space-y-1.5">
            <label htmlFor="password" className="text-xs font-medium text-muted-foreground">
              {mode === "set-password" ? "New password" : "Password"}
            </label>
            <input
              id="password"
              type="password"
              autoComplete={mode === "set-password" ? "new-password" : "current-password"}
              required
              minLength={8}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full rounded-lg border border-input bg-background/40 px-3 py-2 text-sm outline-none transition focus:border-primary/60 focus:shadow-glow"
            />
          </div>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition hover:shadow-glow disabled:opacity-60"
          >
            {busy ? "Working…" : mode === "set-password" ? "Set password" : "Sign in"}
          </button>
        </form>
      </div>
    </main>
  );
}
