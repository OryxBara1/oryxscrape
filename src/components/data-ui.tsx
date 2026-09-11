import type { ReactNode } from "react";

import { Component as GlowRegistryButton } from "@/components/ui/glow-button";
import { Status as HudStatus } from "@/components/ui/hud-status-1";
import { Pattern as LoadingPattern } from "@/components/ui/v-skeleton-8";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/v-table-3-utils/table";
import { CardFrame } from "@/components/ui/v-table-3-utils/card";
import { cn } from "@/lib/utils";

export { LoadingPattern };

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

/**
 * 21st.dev waleedkibhen/glow-button. The registry component only accepts a
 * string `label` and an onClick, so plain string actions render the registry
 * component directly; richer children reuse its `.glow-btn` styling.
 */
export function GlowButton({
  children,
  className,
  variant = "primary",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" }) {
  const classes = cn("glow-btn", variant === "ghost" && "glow-btn--ghost", className);

  if (
    variant === "primary" &&
    typeof children === "string" &&
    !props.disabled &&
    props.type !== "submit"
  ) {
    return (
      <GlowRegistryButton
        label={children}
        className={className}
        {...(props.onClick ? { onClick: () => props.onClick?.({} as never) } : {})}
      />
    );
  }

  return (
    <button {...props} className={classes}>
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

const HUD_VARIANT: Record<string, "primary" | "secondary" | "danger" | "warning"> = {
  ok: "primary",
  live: "primary",
  warn: "warning",
  bad: "danger",
  neutral: "secondary",
};

/** 21st.dev isaiahbjork/hud-status-1 */
export function StatusBadge({ label, tone = "neutral" }: { label: string; tone?: string }) {
  return (
    <HudStatus
      variant={HUD_VARIANT[tone] ?? "secondary"}
      scale={0.72}
      text={label.toUpperCase()}
      className="inline-flex"
    />
  );
}

/** 21st.dev cnippet-dev/v-table-3 */
export function DataTable({
  headers,
  children,
  empty,
  loading,
}: {
  headers: string[];
  children: ReactNode;
  empty?: boolean;
  loading?: boolean;
}) {
  if (loading) {
    return (
      <div className="glass-panel p-4">
        <LoadingPattern />
      </div>
    );
  }

  return (
    <CardFrame className="glass-panel w-full overflow-x-auto p-0">
      <Table variant="card" className="min-w-[720px] text-left text-sm">
        <TableHeader>
          <TableRow>
            {headers.map((h) => (
              <TableHead
                key={h}
                className="px-4 py-3 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground"
              >
                {h}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {empty ? (
            <TableRow>
              <TableCell
                colSpan={headers.length}
                className="px-4 py-10 text-center text-xs text-muted-foreground"
              >
                No records yet.
              </TableCell>
            </TableRow>
          ) : (
            children
          )}
        </TableBody>
      </Table>
    </CardFrame>
  );
}

export function formatDate(value?: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}
