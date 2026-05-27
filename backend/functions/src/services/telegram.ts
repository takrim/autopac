import { logger } from "firebase-functions/v2";
import { getTelegramConfig } from "../config";

// Telegram hard limit is 4096 chars. Leave a small margin.
const MAX_TELEGRAM_LEN = 4000;

/** Split a long message into chunks on newline boundaries, each ≤ MAX_TELEGRAM_LEN. */
function chunkMessage(text: string): string[] {
  if (text.length <= MAX_TELEGRAM_LEN) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > MAX_TELEGRAM_LEN) {
    let cut = remaining.lastIndexOf("\n", MAX_TELEGRAM_LEN);
    if (cut <= 0) cut = MAX_TELEGRAM_LEN; // no newline — hard cut
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

async function sendOne(
  botToken: string,
  chatId: string,
  text: string
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Telegram send failed (${resp.status}): ${body.slice(0, 200)}`);
  }
}

export async function sendTelegramMessage(
  text: string,
  overrides?: { botToken?: string; chatId?: string }
): Promise<void> {
  const cfg = getTelegramConfig();
  const botToken = overrides?.botToken || cfg.botToken;
  const chatId = overrides?.chatId || cfg.chatId;
  if (!botToken || !chatId) {
    logger.warn("[TELEGRAM] Not configured; skipping message");
    return;
  }

  const chunks = chunkMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    try {
      await sendOne(botToken, chatId, chunks[i]);
    } catch (err) {
      logger.error("[TELEGRAM] Send chunk failed", {
        chunkIndex: i,
        chunkLength: chunks[i].length,
        totalChunks: chunks.length,
        error: String(err),
      });
      throw err;
    }
  }
}
