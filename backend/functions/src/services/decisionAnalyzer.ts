import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { sendEmail } from "./email";
import { DecisionLogRecord } from "./decisionLog";
import { formatSeattleDate, formatSeattleDateTime } from "./timeFormat";

const db = getFirestore();
const COLLECTION = "decision_logs";

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const ANALYSIS_RECIPIENT = process.env.ANALYSIS_EMAIL_TO || "cliqueadmin@helpables.org";

interface DecisionRow extends DecisionLogRecord {
  id: string;
  timestamp: Date;
}

/** Pull every decision_logs record from the last `hours` hours. */
async function fetchRecent(hours: number): Promise<DecisionRow[]> {
  const sinceMs = Date.now() - hours * 60 * 60 * 1000;
  const snap = await db.collection(COLLECTION)
    .where("timestamp", ">=", Timestamp.fromMillis(sinceMs))
    .orderBy("timestamp", "desc")
    .limit(2000)
    .get();
  return snap.docs.map(d => {
    const data = d.data() as DecisionLogRecord & { timestamp?: Timestamp };
    return {
      id: d.id,
      ...data,
      timestamp: data.timestamp ? data.timestamp.toDate() : new Date(0),
    };
  });
}

interface Aggregates {
  total: number;
  accepted: number;
  rejected: number;
  bySource: Record<string, { accepted: number; rejected: number }>;
  topRejectReasons: Array<{ reason: string; count: number }>;
  byGate: Array<{ gate: string; count: number }>;
  bySymbol: Record<string, { accepted: number; rejected: number }>;
  buys: number;
  sells: number;
}

/**
 * Map a free-text rejection `reason` to a canonical gate name, for early-exit
 * rejections that don't carry a `checks[]` array. Returns "(other)" if no match.
 */
function gateFromReason(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes("defi category")) return "defi_category";
  if (r.includes("rsi") && r.includes("turn-up")) return "rsi_turn_up";
  if (r.includes("rsi")) return "rsi_oversold_entry";
  if (r.includes("200-ema") || r.includes("ema") || r.includes("downtrend") || r.includes("below trend")) return "trend_filter";
  if (r.includes("1h gain") || r.includes("gain1h") || r.includes("min_gain")) return "min_gain_pct";
  if (r.includes("vol ") || r.includes("volume")) return "min_volume_usd";
  if (r.includes("rank ")) return "max_market_cap_rank";
  if (r.includes("allowlist") || r.includes("coinbase")) return "coinbase_allowlist";
  if (r.includes("already holding")) return "not_already_held";
  if (r.includes("cooldown")) return "cooldown";
  if (r.includes("max open positions") || r.includes("max positions")) return "max_open_positions";
  if (r.includes("order book") || r.includes("bid/ask") || r.includes("bid_ask") || r.includes(" ob ")) return "order_book_pressure";
  if (r.includes("ath")) return "ath_distance";
  if (r.includes("7d") || r.includes("7-day")) return "7d_trend";
  if (r.includes("fdv")) return "fdv_mcap_ratio";
  if (r.includes("price")) return "min_price";
  return "(other)";
}

function aggregate(rows: DecisionRow[]): Aggregates {
  const agg: Aggregates = {
    total: rows.length,
    accepted: 0,
    rejected: 0,
    bySource: {},
    topRejectReasons: [],
    byGate: [],
    bySymbol: {},
    buys: 0,
    sells: 0,
  };
  const reasonCounts: Record<string, number> = {};
  const gateCounts: Record<string, number> = {};
  for (const r of rows) {
    if (r.outcome === "ACCEPTED") agg.accepted++;
    else if (r.outcome === "REJECTED") agg.rejected++;
    if (r.action === "BUY") agg.buys++;
    else if (r.action === "SELL") agg.sells++;

    const src = r.source;
    if (!agg.bySource[src]) agg.bySource[src] = { accepted: 0, rejected: 0 };
    if (r.outcome === "ACCEPTED") agg.bySource[src].accepted++;
    else agg.bySource[src].rejected++;

    const sym = r.symbol || "?";
    if (!agg.bySymbol[sym]) agg.bySymbol[sym] = { accepted: 0, rejected: 0 };
    if (r.outcome === "ACCEPTED") agg.bySymbol[sym].accepted++;
    else agg.bySymbol[sym].rejected++;

    if (r.outcome === "REJECTED" && r.reason) {
      reasonCounts[r.reason] = (reasonCounts[r.reason] || 0) + 1;
    }

    // Failing-gate aggregation: prefer structured checks[]; fall back to reason text.
    if (r.outcome === "REJECTED") {
      const checks = (r as DecisionRow & { checks?: Array<{ name: string; passed: boolean }> }).checks;
      if (Array.isArray(checks) && checks.length > 0) {
        for (const c of checks) {
          if (!c.passed && c.name) gateCounts[c.name] = (gateCounts[c.name] || 0) + 1;
        }
      } else if (r.reason) {
        const gate = gateFromReason(r.reason);
        gateCounts[gate] = (gateCounts[gate] || 0) + 1;
      }
    }
  }
  agg.topRejectReasons = Object.entries(reasonCounts)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);
  agg.byGate = Object.entries(gateCounts)
    .map(([gate, count]) => ({ gate, count }))
    .sort((a, b) => b.count - a.count);
  return agg;
}

/** Compact, model-friendly summary of each decision row. */
function compactRows(rows: DecisionRow[], max = 400): string {
  const sliced = rows.slice(0, max);
  return sliced.map(r => {
    const ts = formatSeattleDateTime(r.timestamp);
    const price = r.price != null ? ` @ ${r.price}` : "";
    const exp = r.expression ? ` :: ${r.expression}` : "";
    return `${ts} [${r.source}] ${r.outcome} ${r.action} ${r.symbol}${price} — ${r.reason}${exp}`;
  }).join("\n");
}

function buildPrompt(rows: DecisionRow[], agg: Aggregates): string {
  return `You are an expert quantitative trading analyst reviewing 24h of automated trading decisions for an AutoPac crypto trading bot.

The bot has multiple decision sources:
- burst_scanner: scans CoinGecko top gainers every 5min, scores them, and auto-buys
- risk_check: portfolio-wide gates (daily trade limits, exposure caps)
- liquidator: monitors open positions every 1min, sets/trails stop losses, liquidates on red candles
- manual_buy / webhook / auto_approve: TradingView and user-driven entries

Each log has source, outcome (ACCEPTED/REJECTED), action (BUY/SELL/OTHER), symbol, price, reason, and a one-line "expression" formula.

== AGGREGATE STATS (last 24h) ==
Total decisions: ${agg.total}
Accepted: ${agg.accepted}  Rejected: ${agg.rejected}
Buys: ${agg.buys}  Sells: ${agg.sells}

By source:
${Object.entries(agg.bySource).map(([s, v]) => `  ${s}: ${v.accepted} accepted / ${v.rejected} rejected`).join("\n")}

Top rejection reasons:
${agg.topRejectReasons.map(r => `  ${r.count}× ${r.reason}`).join("\n") || "  (none)"}

Rejections by failing gate (from structured checks[] + reason-text inference):
${agg.byGate.map(g => `  ${g.count}× ${g.gate}`).join("\n") || "  (none)"}

Most active symbols (top 15 by total decisions):
${Object.entries(agg.bySymbol).sort((a, b) => (b[1].accepted + b[1].rejected) - (a[1].accepted + a[1].rejected)).slice(0, 15).map(([sym, v]) => `  ${sym}: ${v.accepted}A / ${v.rejected}R`).join("\n")}

== RAW DECISIONS (most recent first, up to 400) ==
${compactRows(rows)}

== YOUR TASK ==
Produce a detailed analytical report in clean HTML (use <h2>, <h3>, <ul>, <li>, <table>, <strong>, <code> — NO <html>, <head>, or <body> tags, NO markdown). Cover:

1. <h2>Executive Summary</h2> — 3-5 sentence overview of the day: how active was the bot, hit rate, dominant rejection patterns, any standout symbols.
2. <h2>Strategy Performance</h2> — per-source breakdown: was burst_scanner being too conservative or aggressive? Were liquidator stop-loss/trailing decisions timely?
3. <h2>Rejection Pattern Analysis</h2> — group the top rejection reasons AND the failing-gate counts above. Call out the dominant gate(s) by name (e.g. <code>rsi_oversold_entry</code>) and the share of rejections they cause. For each, explain what it implies about market conditions or strategy calibration, and whether thresholds should be relaxed/tightened.
4. <h2>Symbol-Level Insights</h2> — call out any symbol that appeared repeatedly, was bought then quickly stopped out, or had unusual decision patterns. Comment on quality of selections.
5. <h2>Risk &amp; Concentration</h2> — were daily trade limits hit? Any signs of over-trading or churn (BUY then immediate SELL within minutes)?
6. <h2>Recommendations</h2> — 3-7 concrete, actionable tuning suggestions (specific parameter changes, e.g. "raise min_gain_pct from 3% to 4%" if the data supports it). Be specific, cite evidence from the data.
7. <h2>Anomalies</h2> — anything unusual, contradictory, or that looks like a bug.

Be concrete and quantitative — cite specific numbers, symbols, and timestamps. Keep total length under ~1500 words. Use <code> for parameter names and numeric thresholds.`;
}

async function callGemini(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 4096,
      },
    }),
  });
  const data = await resp.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    error?: { message?: string };
  };
  if (!resp.ok) {
    throw new Error(`Gemini ${resp.status}: ${data.error?.message || JSON.stringify(data)}`);
  }
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join("\n") || "";
  if (!text) throw new Error("Gemini returned empty response");
  return text;
}

function wrapEmailHtml(analysisHtml: string, agg: Aggregates, dateLabel: string): string {
  const gateTable = agg.byGate.length === 0 ? "" : `
  <h2 style="font-size:15px;color:#1e3a8a;margin:18px 0 8px;">Rejections by Failing Gate</h2>
  <table style="border-collapse:collapse;width:100%;font-size:13px;max-width:480px;"><thead><tr style="background:#f1f5f9;"><th style="text-align:left;padding:6px 8px;">Gate</th><th style="text-align:right;padding:6px 8px;width:80px;">Count</th><th style="text-align:right;padding:6px 8px;width:80px;">Share</th></tr></thead><tbody>${agg.byGate.map(g => `<tr><td style="padding:6px 8px;border-top:1px solid #e5e7eb;font-family:ui-monospace,Menlo,monospace;">${g.gate}</td><td style="padding:6px 8px;border-top:1px solid #e5e7eb;text-align:right;">${g.count}</td><td style="padding:6px 8px;border-top:1px solid #e5e7eb;text-align:right;color:#666;">${agg.rejected > 0 ? ((g.count / agg.rejected) * 100).toFixed(1) + "%" : "—"}</td></tr>`).join("")}</tbody></table>`;
  return `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 760px; margin: 0 auto; padding: 24px; color: #222; line-height: 1.55;">
  <div style="border-bottom: 2px solid #2563eb; padding-bottom: 12px; margin-bottom: 24px;">
    <h1 style="margin:0; color: #1e3a8a;">AutoPac · Daily Decision Analysis</h1>
    <div style="color:#666; font-size: 13px; margin-top: 4px;">${dateLabel} · ${agg.total} decisions · ${agg.accepted} accepted / ${agg.rejected} rejected</div>
  </div>
  ${gateTable}
  ${analysisHtml}
  <hr style="margin-top: 32px; border: none; border-top: 1px solid #ddd;">
  <div style="color:#888; font-size: 12px;">Generated by AutoPac Gemini Analyzer · model: <code>${GEMINI_MODEL}</code></div>
</body></html>`;
}

/**
 * Main entry — pulls last N hours of decisions (default 24), runs Gemini analysis, emails the result.
 * Called by the `decisionAnalyzer` scheduled function and by Telegram /analyze command.
 * Returns a short summary suitable for inline Telegram reply.
 */
export async function runDecisionAnalyzer(hours = 24): Promise<{
  decisions: number;
  accepted: number;
  rejected: number;
  emailId?: string;
  emailError?: string;
}> {
  const rows = await fetchRecent(hours);
  logger.info("[DECISION_ANALYZER] Fetched decisions", { count: rows.length, hours });

  if (rows.length === 0) {
    const html = wrapEmailHtml(
      `<h2>No activity</h2><p>No trade decisions were logged in the last ${hours} hours.</p>`,
      { total: 0, accepted: 0, rejected: 0, bySource: {}, topRejectReasons: [], byGate: [], bySymbol: {}, buys: 0, sells: 0 },
      formatSeattleDate(),
    );
    const result = await sendEmail({
      to: ANALYSIS_RECIPIENT,
      subject: `AutoPac · Decision Analysis · ${formatSeattleDate()} · 0 decisions (${hours}h)`,
      html,
    });
    return { decisions: 0, accepted: 0, rejected: 0, emailId: result.id, emailError: result.error };
  }

  const agg = aggregate(rows);
  const prompt = buildPrompt(rows, agg);
  const analysis = await callGemini(prompt);
  // Gemini sometimes wraps output in ```html ... ``` — strip it.
  const cleanedAnalysis = analysis
    .replace(/^\s*```html\s*/i, "")
    .replace(/^\s*```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  const dateLabel = formatSeattleDate();
  const html = wrapEmailHtml(cleanedAnalysis, agg, `${dateLabel} (last ${hours}h)`);
  const subject = `AutoPac · Decision Analysis · ${dateLabel} · ${agg.accepted}A/${agg.rejected}R (${hours}h)`;

  const result = await sendEmail({ to: ANALYSIS_RECIPIENT, subject, html });
  if (!result.ok) {
    logger.error("[DECISION_ANALYZER] Email send failed", { error: result.error });
  } else {
    logger.info("[DECISION_ANALYZER] Sent analysis email", { id: result.id, decisions: rows.length });
  }
  return {
    decisions: rows.length,
    accepted: agg.accepted,
    rejected: agg.rejected,
    emailId: result.id,
    emailError: result.ok ? undefined : result.error,
  };
}
