/**
 * Telegram formatters for the crypto monitor — the per-coin drill-down.
 * `formatBeginnerBreakdown` is the default plain-English view; `formatBreakdown`
 * is the technical, check-by-check view (via `/coin <sym> full`).
 */

import { ScoreResult, ScoreCheck, Category, SCORING } from "./scoring";
import { WatchCoin } from "./watchlist";

function icon(c: ScoreCheck): string {
  if (c.points > 0) return "✓";
  if (c.points < 0) return "⚠";
  return "✗";
}

function block(title: string, checks: ScoreCheck[], subtotal: number, max: number): string {
  const lines = checks.map(c => `  ${icon(c)} ${c.expression}`).join("\n");
  return `*${title}* (${subtotal}/${max})\n${lines}`;
}

/** Full block-by-block breakdown for `/coin <symbol>`. */
export function formatBreakdown(coin: WatchCoin, r: ScoreResult, price: number): string {
  const priceStr = price >= 1 ? `$${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : `$${price.toPrecision(4)}`;

  const gate = [
    `total ${r.total} ≥ ${SCORING.STRONG_BUY.total} ${r.total >= SCORING.STRONG_BUY.total ? "✓" : "✗"}`,
    `fundamental ${r.fundamental} ≥ ${SCORING.STRONG_BUY.fundamental} ${r.fundamental >= SCORING.STRONG_BUY.fundamental ? "✓" : "✗"}`,
    `technical ${r.technical} ≥ ${SCORING.STRONG_BUY.technical} ${r.technical >= SCORING.STRONG_BUY.technical ? "✓" : "✗"}`,
    `no major negative news ${r.hasMajorNegativeNews ? "✗" : "✓"}`,
  ].join("\n  ");

  return [
    `🔬 *${coin.symbol}* (${coin.coinbaseProductId}) — *${r.category}*`,
    `Price: ${priceStr}   Total: *${r.total}/40*`,
    "",
    block("Fundamental", r.checks.fundamental, r.fundamental, 15),
    "",
    block("News", r.checks.news, r.news, 10),
    "",
    block("Technical", r.checks.technical, r.technical, 15),
    "",
    `*STRONG_BUY gate:*\n  ${gate}`,
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
    case "positive_catalysts":
      return p > 0 ? { tone: "good", text: `Positive news/catalysts recently` } : null;
    case "negative_events":
      return p < 0 ? { tone: "bad", text: `Negative news recently (e.g. hack, lawsuit, outage)` } : null;
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

const VERDICT: Record<Category, { emoji: string; title: string; meaning: string; bottom: string }> = {
  STRONG_BUY: {
    emoji: "🚀", title: "Strong Buy",
    meaning: "multiple signals line up for a potential entry.",
    bottom: "Looks like a high-quality setup right now — but only invest what you can afford to lose.",
  },
  WATCHLIST: {
    emoji: "👀", title: "Watchlist",
    meaning: "interesting, but not a clear buy yet.",
    bottom: "Worth keeping an eye on. Wait for the setup to line up more before entering.",
  },
  AVOID: {
    emoji: "🛑", title: "Avoid (for now)",
    meaning: "the signals don't support buying here.",
    bottom: "Not a good entry right now based on its trend, news and fundamentals.",
  },
};

/** Plain-English summary for `/coin <symbol>` (default view). */
export function formatBeginnerBreakdown(coin: WatchCoin, r: ScoreResult, price: number): string {
  const priceStr = price >= 1 ? `$${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : `$${price.toPrecision(4)}`;
  const v = VERDICT[r.category];
  const strength = r.total >= SCORING.STRONG_BUY.total ? "strong" : r.total >= SCORING.WATCHLIST_MIN ? "mixed" : "weak";

  const all = [...r.checks.fundamental, ...r.checks.news, ...r.checks.technical];
  const goods: string[] = [];
  const bads: string[] = [];
  for (const c of all) {
    const f = friendly(c);
    if (!f) continue;
    const arr = f.tone === "good" ? goods : bads;
    if (!arr.includes(f.text)) arr.push(f.text); // de-dupe (e.g. two pullback checks)
  }

  const lines = [
    `${v.emoji} *${coin.symbol}* — *${v.title}*`,
    `_${capitalize(v.meaning)}_`,
    `Price: ${priceStr}   ·   Score: *${r.total}/40* (${strength})`,
  ];
  if (goods.length) lines.push("", "✅ *In its favour:*", ...goods.map(t => `• ${t}`));
  if (bads.length) lines.push("", "⚠️ *Things to watch:*", ...bads.map(t => `• ${t}`));
  lines.push("", `*Bottom line:* ${v.bottom}`);
  lines.push("", `_Educational only, not financial advice._  ·  _/coin ${coin.symbol} full for the numbers_`);
  return lines.join("\n");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
