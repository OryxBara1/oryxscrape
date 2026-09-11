import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";

import { DataTable, Field, ScreenHeader, StatusBadge, formatDate, inputClass } from "@/components/data-ui";
import { listAuditEvents } from "@/lib/audit.functions";
import type { Database } from "@/integrations/supabase/types";

type CheckType = Database["public"]["Enums"]["audit_check_type"];

const CHECK_TYPES: CheckType[] = [
  "duplicate",
  "consistency",
  "tier_drift",
  "tos_recheck",
  "robots_recheck",
];

export const Route = createFileRoute("/_authenticated/audit")({
  head: () => ({
    meta: [
      { title: "Audit log — OryxScrape" },
      {
        name: "description",
        content:
          "History of duplicate, consistency, tier-drift and compliance re-check runs.",
      },
      { property: "og:title", content: "Audit log — OryxScrape" },
      {
        property: "og:description",
        content: "Duplicate, consistency and compliance check history for collected data.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: AuditScreen,
});

function AuditScreen() {
  const [checkType, setCheckType] = useState<string>("");
  const [result, setResult] = useState<string>("");
  const fetchEvents = useServerFn(listAuditEvents);

  const { data, isLoading, error } = useQuery({
    queryKey: ["audit-events", checkType, result],
    queryFn: () =>
      fetchEvents({
        data: {
          checkType: (checkType || null) as CheckType | null,
          result: result || null,
        },
      }),
  });

  const rows = data ?? [];

  return (
    <section className="space-y-6">
      <ScreenHeader
        title="Audit log"
        description="Duplicate, consistency, tier-drift, ToS and robots re-check history."
      />

      <div className="glass-panel grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Check type">
          <select
            className={inputClass}
            value={checkType}
            onChange={(e) => setCheckType(e.target.value)}
          >
            <option value="">All</option>
            {CHECK_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Result">
          <input
            className={inputClass}
            value={result}
            placeholder="ok"
            onChange={(e) => setResult(e.target.value)}
          />
        </Field>
      </div>

      {error ? (
        <div className="glass-panel p-5 text-sm text-rose-300">{(error as Error).message}</div>
      ) : null}

      <DataTable
        headers={["Check", "Target", "Result", "Findings", "Run at"]}
        empty={!isLoading && rows.length === 0}
      >
        {rows.map((event) => (
          <tr key={event.id} className="border-b border-border/40 last:border-0">
            <td className="px-4 py-3 font-medium">{event.check_type}</td>
            <td className="px-4 py-3 text-xs text-muted-foreground">
              {event.target_table ?? "—"}
              {event.target_id ? ` · ${event.target_id.slice(0, 8)}` : ""}
            </td>
            <td className="px-4 py-3">
              <StatusBadge label={event.result} tone={event.result === "ok" ? "ok" : "warn"} />
            </td>
            <td className="px-4 py-3">
              <pre className="max-w-96 overflow-x-auto font-mono text-[11px] text-muted-foreground">
                {JSON.stringify(event.findings)}
              </pre>
            </td>
            <td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(event.run_at)}</td>
          </tr>
        ))}
      </DataTable>
    </section>
  );
}
