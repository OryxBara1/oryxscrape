import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function ScreenHeader({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="glow-text text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      {action}
    </header>
  );
}

export function GlowButton({
  children,
  className,
  variant = "primary",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" }) {
  return (
    <button
      {...props}
      className={cn(
        "rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:opacity-50",
        variant === "primary"
          ? "bg-primary/15 text-foreground shadow-glow hover:bg-primary/25"
          : "border border-border text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

export const inputClass =
  "rounded-lg border border-border bg-black/20 px-3 py-2 text-sm text-foreground outline-none transition focus:border-primary/50 focus:shadow-glow";

export function StatusBadge({ label, tone = "neutral" }: { label: string; tone?: string }) {
  const tones: Record<string, string> = {
    ok: "border-emerald-400/40 text-emerald-300",
    warn: "border-amber-400/40 text-amber-300",
    bad: "border-rose-400/40 text-rose-300",
    live: "border-primary/50 text-primary shadow-glow",
    neutral: "border-border text-muted-foreground",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em]",
        tones[tone] ?? tones["neutral"],
      )}
    >
      {label}
    </span>
  );
}

export function DataTable({
  headers,
  children,
  empty,
}: {
  headers: string[];
  children: ReactNode;
  empty?: boolean;
}) {
  return (
    <div className="glass-panel overflow-x-auto p-0">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead>
          <tr className="border-b border-border/60">
            {headers.map((h) => (
              <th
                key={h}
                className="px-4 py-3 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {empty ? (
            <tr>
              <td
                colSpan={headers.length}
                className="px-4 py-10 text-center text-xs text-muted-foreground"
              >
                No records yet.
              </td>
            </tr>
          ) : (
            children
          )}
        </tbody>
      </table>
    </div>
  );
}

export function formatDate(value?: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}
