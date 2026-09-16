/**
 * Slack notifications for scheduled collection (server-only).
 *
 * Gateway-backed Slack connection. Notifications are best-effort: a Slack
 * failure must never fail a collection run, it is logged instead.
 */

const GATEWAY_URL = "https://connector-gateway.lovable.dev/slack/api";

export const SLACK_ALERT_CHANNEL = "#auramaris-compliance";

export async function postSlack(text: string): Promise<{ ok: boolean; error?: string }> {
  const lovableKey = process.env["LOVABLE_API_KEY"];
  const slackKey = process.env["SLACK_API_KEY"];
  if (!lovableKey || !slackKey) {
    console.error("[slack] missing LOVABLE_API_KEY or SLACK_API_KEY; notification skipped");
    return { ok: false, error: "slack_not_configured" };
  }

  try {
    const response = await fetch(`${GATEWAY_URL}/chat.postMessage`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lovableKey}`,
        "X-Connection-Api-Key": slackKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: SLACK_ALERT_CHANNEL, text }),
    });
    const body = await response.text();
    if (!response.ok) {
      console.error(`[slack] gateway failed [${response.status}]: ${body}`);
      return { ok: false, error: `HTTP ${response.status}: ${body}` };
    }
    const data = JSON.parse(body) as { ok?: boolean; error?: string };
    if (!data.ok) {
      console.error(`[slack] chat.postMessage error: ${data.error}`);
      return { ok: false, error: data.error ?? "unknown" };
    }
    return { ok: true };
  } catch (error) {
    const message = (error as Error).message;
    console.error("[slack] notification failed", message);
    return { ok: false, error: message };
  }
}
