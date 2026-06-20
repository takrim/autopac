/**
 * Telegram formatters for the crypto monitor — the per-coin drill-down that
 * shows exactly how a score was computed.
 */

import { ScoreResult, ScoreCheck, SCORING } from "./scoring";
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
