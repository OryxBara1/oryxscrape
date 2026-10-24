/**
 * Collection-failure alerts (server-only), sent through OryxScrape's own
 * Resend connection. Fixed recipient; never throws into the collector.
 * No credentials are ever included in the message.
 */

const GATEWAY_URL = "https://connector-gateway.lovable.dev/resend";
export const OPS_ALERT_RECIPIENT = "ops@auramaris.app";

export type FailureAttempt = { engine: string; ok: boolean; error?: string };

export type CollectionFailureAlert = {
  url: string;
  sourceId: string;
  sourceName?: string | null;
  jobId?: string | null;
  rawItemId?: string | null;
  finalError: string;
  attempts?: FailureAttempt[];
  occurredAt?: Date;
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function buildFailureEmail(a: CollectionFailureAlert) {
  const when = a.occurredAt ?? new Date();
  const host = (() => {
    try {
      return new URL(a.url).hostname;
    } catch {
      return a.url;
    }
  })();
  const utc = when.toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const lisbon = when.toLocaleString("pt-PT", { timeZone: "Europe/Lisbon" });
  const subject = `[OryxScrape] Falha de coleta: ${host}`;
  const rows: [string, string][] = [
    ["Website", host],
    ["URL", a.url],
    ["Fonte", `${a.sourceName ?? "—"} (${a.sourceId})`],
    ["Data/hora", `${utc} · Lisboa ${lisbon}`],
    ["Motivo final", a.finalError.slice(0, 500)],
    ["Job", a.jobId ?? "—"],
    ["Item bloqueado", a.rawItemId ?? "—"],
  ];
  const attempts = (a.attempts ?? [])
    .map((t) => `<li><b>${esc(t.engine)}</b>: ${t.ok ? "ok" : esc(t.error ?? "falhou")}</li>`)
    .join("");
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111">
<h2 style="margin:0 0 12px">Falha de coleta — todas as tentativas automáticas falharam</h2>
<table cellpadding="6" style="border-collapse:collapse">${rows
    .map(([k, v]) => `<tr><td style="color:#555">${esc(k)}</td><td>${esc(v)}</td></tr>`)
    .join("")}</table>
${attempts ? `<h3>Tentativas</h3><ul>${attempts}</ul>` : ""}
<p>O item foi enviado para a Manual Upload Queue e aguarda upload manual por um revisor.</p>
</div>`;
  return { subject, html };
}

export async function sendCollectionFailureAlert(a: CollectionFailureAlert): Promise<boolean> {
  try {
    const lovableKey = process.env.LOVABLE_API_KEY;
    const resendKey = process.env.RESEND_API_KEY;
    if (!lovableKey || !resendKey) {
      console.error("[ops-alert] email not configured; skipping alert for", a.url);
      return false;
    }
    const from = process.env.OPS_ALERT_FROM || "OryxScrape <onboarding@resend.dev>";
    const { subject, html } = buildFailureEmail(a);
    const res = await fetch(`${GATEWAY_URL}/emails`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${lovableKey}`,
        "X-Connection-Api-Key": resendKey,
        ...(a.rawItemId ? { "Idempotency-Key": `blocked-${a.rawItemId}` } : {}),
      },
      body: JSON.stringify({ from, to: [OPS_ALERT_RECIPIENT], subject, html }),
    });
    if (!res.ok) {
      console.error(`[ops-alert] send failed [${res.status}]: ${(await res.text()).slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[ops-alert] send error", (e as Error).message);
    return false;
  }
}
