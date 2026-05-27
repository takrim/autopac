import { logger } from "firebase-functions/v2";

/**
 * Send an email via Resend API (https://resend.com).
 * Requires RESEND_API_KEY secret. Uses onboarding@resend.dev as a sender by default
 * (works only for delivering to the Resend account owner's email until a domain is verified).
 */
export async function sendEmail(opts: {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
}): Promise<{ ok: boolean; id?: string; error?: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.error("[EMAIL] RESEND_API_KEY not set");
    return { ok: false, error: "RESEND_API_KEY not set" };
  }

  const from = opts.from || process.env.RESEND_FROM || "AutoPac <onboarding@resend.dev>";
  const to = Array.isArray(opts.to) ? opts.to : [opts.to];

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to,
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
      }),
    });

    const data = (await resp.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
    if (!resp.ok) {
      const errMsg = data.message || data.name || `HTTP ${resp.status}`;
      logger.error("[EMAIL] Resend error", { status: resp.status, error: errMsg });
      return { ok: false, error: errMsg };
    }
    return { ok: true, id: data.id };
  } catch (err) {
    logger.error("[EMAIL] Send failed", { error: String(err) });
    return { ok: false, error: String(err) };
  }
}
