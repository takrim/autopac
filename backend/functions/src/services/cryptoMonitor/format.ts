/**
 * Telegram formatters for the crypto monitor — the per-coin drill-down.
 * `formatBeginnerBreakdown` is the default plain-English view; `formatBreakdown`
 * is the technical, check-by-check view (via `/coin <sym> full`). Both surface
 * the triggered strategies + the selected alert.
 */

import { ScoreResult, ScoreCheck } from "./scoring";
import { WatchCoin } from "./watchlist";
import { evaluateAll, selectAlert, AlertType, StrategyResult } from "./strategies";

export const ALERT_META: Record<AlertType | "NONE", { emoji: string; title: string }> = {
  RISK_BLOCK: { emoji: "🛑", title: "Risk Block" },
  STRONG_BUY: { emoji: "🚀", title: "Strong Buy" },
  PULLBACK_BUY_ZONE: { emoji: "🎯", title: "Pullback Buy Zone" },
  BUY_SETUP: { emoji: "✅", title: "Buy Setup" },
  MOMENTUM_BREAKOUT: { emoji: "🚦", title: "Momentum Breakout" },
  ACCUMULATION_SETUP: { emoji: "🧺", title: "Accumulation Setup" },
  FUNDAMENTAL_WATCH: { emoji: "👀", title: "Fundamental Watch" },
  NONE: { emoji: "⚪", title: "No signal" },
};

function icon(c: ScoreCheck): string {
  if (c.points > 0) return "✓";
  if (c.points < 0) return "⚠";
  return "✗";
}

function block(title: string, checks: ScoreCheck[], subtotal: number, max: number): string {
  const lines = checks.map(c => `  ${icon(c)} ${c.expression}`).join("\n");
  return `*${title}* (${subtotal}/${max})\n${lines}`;
}

function strategyLines(triggered: StrategyResult[]): string {
  if (triggered.length === 0) return "  (none triggered)";
  return triggered.map(s => `  ${ALERT_META[s.name].emoji} ${ALERT_META[s.name].title}`).join("\n");
}

/** Full block-by-block breakdown for `/coin <symbol> full`. */
export function formatBreakdown(coin: WatchCoin, r: ScoreResult, price: number): string {
  const priceStr = price >= 1 ? `$${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : `$${price.toPrecision(4)}`;
  const { selected, triggered } = selectAlert(evaluateAll(r));
  const sel = selected ? ALERT_META[selected.name] : ALERT_META.NONE;

  const idSuffix = coin.coinbaseProductId && coin.coinbaseProductId !== coin.symbol ? ` (${coin.coinbaseProductId})` : "";
  return [
    `🔬 *${coin.symbol}*${idSuffix} — ${sel.emoji} *${sel.title}*`,
    `Price: ${priceStr}   F:${r.fundamental}  N:${r.news}  T:${r.technical}  Total:*${r.total}*`,
    "",
    block("Fundamental", r.checks.fundamental, r.fundamental, 15),
    "",
    block("News", r.checks.news, r.news, 4),
    "",
    block("Technical", r.checks.technical, r.technical, 15),
    "",
    `*Triggered strategies:*\n${strategyLines(triggered)}`,
  ].join("\n");
}

// ── Beginner-friendly view ───────────────────────────────────────────────────

type Tone = "good" | "bad";

/** Translate one scored check into a plain-English line (or null to omit). */
function friendly(c: ScoreCheck): { tone: Tone; text: string } | null {
  const p = c.points;
  const a = c.actual;
  switch (c.name) {
    case "market_cap_rank":
      return p > 0 ? { tone: "good", text: `Established coin (market rank #${a})` }
                   : { tone: "bad", text: `Smaller, lower-ranked coin — more speculative` };
    case "volume_growth":
      return p > 0 ? { tone: "good", text: `Trading activity is surging vs its usual` } : null;
    case "tvl_growth_30d":
      return p > 0 ? { tone: "good", text: `More money flowing into its ecosystem lately` } : null;
    case "stablecoin_inflow_30d":
      return p > 0 ? { tone: "good", text: `Fresh stablecoin cash entering its network` } : null;
    case "ecosystem_revenue":
      return p > 0 ? { tone: "good", text: `The network is earning more fees (real usage)` } : null;
    // News is rendered separately as a "Recent news" section.
    case "bullish_news":
    case "soft_bearish_news":
    case "major_bearish":
      return null;
    case "price_above_ema200":
      return p > 0 ? { tone: "good", text: `Price is above its long-term average — overall uptrend` }
                   : { tone: "bad", text: `Price is below its long-term average — overall downtrend` };
    case "ema50_above_ema200":
      return p > 0 ? { tone: "good", text: `Medium-term trend is bullish` } : null;
    case "ema200_rising":
      return p > 0 ? { tone: "good", text: `Long-term trend is still climbing` } : null;
    case "rsi_momentum":
      if (p === -3) return { tone: "bad", text: `Overbought — momentum stretched, pullback risk` };
      return p > 0 ? { tone: "good", text: `Momentum looks healthy (not overheated)` } : null;
    case "pullback_near_ema20":
    case "pullback_near_ema50":
      return p > 0 ? { tone: "good", text: `Price pulled back to a support area — a common entry spot` } : null;
    case "risk_24h":
      return p < 0 ? { tone: "bad", text: `Already up sharply today (${a}%) — may be late to enter` } : null;
    case "risk_7d":
      return p < 0 ? { tone: "bad", text: `Up a lot this week (${a}%) — extended` } : null;
    default:
      return null;
  }
}

/** Plain-English summary for `/coin <symbol>` (default view). */
export function formatBeginnerBreakdown(coin: WatchCoin, r: ScoreResult, price: number): string {
  const priceStr = price >= 1 ? `$${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : `$${price.toPrecision(4)}`;
  const { selected, triggered } = selectAlert(evaluateAll(r));
  const sel = selected ? ALERT_META[selected.name] : ALERT_META.NONE;

  const all = [...r.checks.fundamental, ...r.checks.news, ...r.checks.technical];
  const goods: string[] = [];
  const bads: string[] = [];
  for (const c of all) {
    const fr = friendly(c);
    if (!fr) continue;
    const arr = fr.tone === "good" ? goods : bads;
    if (!arr.includes(fr.text)) arr.push(fr.text); // de-dupe (e.g. two pullback checks)
  }

  const lines = [
    `${sel.emoji} *${coin.symbol}* — *${sel.title}*`,
    `Price: ${priceStr}   ·   F:${r.fundamental} N:${r.news} T:${r.technical} (total ${r.total})`,
  ];

  // Signals (the separate strategies)
  lines.push("", "🎯 *Signals:*");
  if (triggered.length) lines.push(...triggered.map(s => `${ALERT_META[s.name].emoji} ${ALERT_META[s.name].title}`));
  else lines.push("• No strategy triggered right now");

  if (goods.length) lines.push("", "✅ *In its favour:*", ...goods.map(t => `• ${t}`));
  if (bads.length) lines.push("", "⚠️ *Things to watch:*", ...bads.map(t => `• ${t}`));

  // Recent news — weighed across sources; show the actual headlines with sentiment.
  const sentLabel: Record<string, string> = { bullish: "📈 bullish", bearish: "📉 bearish", mixed: "↔️ mixed", neutral: "• neutral" };
  const sentIcon: Record<string, string> = { bullish: "📈", bearish: "📉", neutral: "•" };
  lines.push("", `📰 *Recent news* — overall ${sentLabel[r.newsSentiment] ?? "• neutral"}:`);
  if (r.newsHeadlines.length) {
    for (const h of r.newsHeadlines.slice(0, 5)) lines.push(`${sentIcon[h.sentiment]} ${clip(h.title)}`);
  } else {
    lines.push("_No headlines found across sources right now._");
  }

  if (selected) {
    if (selected.risks.length) lines.push("", "⚠️ *Risk:*", ...selected.risks.map(t => `• ${t}`));
    lines.push("", `*Action:* ${selected.action}`);
  } else {
    lines.push("", "*Action:* Nothing actionable right now — keep monitoring.");
  }
  lines.push("", `_Educational only, not financial advice._  ·  _/coin ${coin.symbol} full for the numbers_`);
  return lines.join("\n");
}

function clip(s: string, max = 140): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Strip the lightweight Telegram markdown (*bold*, _italic_) for plain-text UIs. */
export function toPlainText(s: string): string {
  return s.replace(/[*_]/g, "");
}
