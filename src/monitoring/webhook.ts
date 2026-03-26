/** Fire-and-forget webhook sender. Accepts Slack ({ text }) or Discord ({ content }) payloads. */
export async function sendWebhook(url: string, payload: Record<string, unknown>): Promise<void> {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // fire-and-forget — caller logs the attempt
  }
}
