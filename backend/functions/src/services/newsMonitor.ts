/**
 * News Monitor
 *
 * Runs every 30 minutes. Collects all active BUY signals (last 24 h) and open
 * positions, fetches the latest Google News headlines for each symbol, scores
 * them for bullish/bearish sentiment, overlays order-book analysis + 24h volume,
 * and sends a Telegram digest with a final recommendation per symbol.
 */

import { logger } from "firebase-functions/v2";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { getTradingConfig } from "../api/config";
import { getBroker } from "../brokers";
import { normalizeBookSymbol, fetchOrderBook, scoreBook, BookScore } from "./orderbook";
import { sendTelegramMessage } from "./telegram";

const TOP_GAINERS_COUNT = 40;    // how many top-gaining Coinbase symbols to analyse
const MIN_VOLUME_USD    = 50_000; // ignore symbols with < $50k 24h volume (noise filter)

// ---------------------------------------------------------------------------
// Sentiment keywords
// ---------------------------------------------------------------------------

const BULLISH_KEYWORDS = [
  // momentum / price action
  "surge", "surging", "surged", "rally", "rallying", "rallied", "bull", "bullish",
  "gain", "gains", "rise", "rising", "rose", "soar", "soaring", "soared",
  "climb", "climbing", "climbed", "jump", "jumping", "jumped", "spike", "spiking",
  "breakout", "break out", "breaks out", "broke out", "all-time high", "ath",
  "record high", "new high", "multi-month high", "multi-year high", "52-week high",
  "higher", "upside", "uptrend", "momentum",
  // fundamental / adoption
  "upgrade", "outperform", "beat", "strong", "positive", "buy",
  "accumulate", "accumulation", "growth", "growing", "adoption", "partnership",
  "launch", "launches", "launched", "milestone", "institutional",
  "approved", "approval", "etf", "listing", "listed", "boost",
  "investment", "investors", "inflow", "inflows", "demand",
  "halving", "staking", "integration", "expansion", "mainstream",
  "whale", "whales", "stack", "stacking", "hodl",
];

const BEARISH_KEYWORDS = [
  // price action
  "crash", "crashing", "crashed", "drop", "dropping", "dropped",
  "fall", "falling", "fell", "bearish", "bear", "decline", "declining", "declined",
  "plunge", "plunging", "plunged", "dump", "dumping", "dumped",
  "selloff", "sell-off", "correction", "tumble", "tumbling",
  "lower", "downside", "downtrend", "slump", "slumping",
  // fundamental / risk
  "downgrade", "underperform", "miss", "weak", "negative", "warning",
  "risk", "fear", "concern", "fraud", "hack", "hacked", "exploit",
  "ban", "banned", "lawsuit", "sec", "investigation", "probe",
  "collapse", "bubble", "rug", "scam", "delisted", "delist",
  "liquidation", "liquidations", "outflow", "outflows",
];

// Ticker → full name for richer news search (only needed where symbol alone is ambiguous)
const NAME_MAP: Record<string, string> = {
  BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", ADA: "Cardano",
  DOT: "Polkadot", XRP: "Ripple", DOGE: "Dogecoin", AVAX: "Avalanche",
  LINK: "Chainlink", MATIC: "Polygon", SUI: "Sui", NEAR: "NEAR Protocol",
  ARB: "Arbitrum", OP: "Optimism", APT: "Aptos", ICP: "Internet Computer",
  HNT: "Helium",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function scoreSentiment(title: string): "bullish" | "bearish" | "neutral" {
  const lower = title.toLowerCase();
  const bullish = BULLISH_KEYWORDS.filter(k => lower.includes(k)).length;
  const bearish = BEARISH_KEYWORDS.filter(k => lower.includes(k)).length;
  if (bullish > bearish) return "bullish";
  if (bearish > bullish) return "bearish";
  return "neutral";
}

export interface NewsArticle {
  title: string;
  source: string;
  publishedAt: number;
  sentiment: "bullish" | "bearish" | "neutral";
}

export async function fetchNewsForSymbol(symbol: string): Promise<NewsArticle[]> {
  // Strip quote suffix: BTC-USD → BTC, BTCUSD → BTC
  const base = symbol.replace(/-USD.*$/, "").replace(/USD[CT]?$/i, "");
  const name = NAME_MAP[base.toUpperCase()] || base;

  // Try progressively broader queries until we get results
  const queries = [
    `${name} crypto`,
    `${name} coin`,
    `${name} token`,
    name,
  ];

  const cutoffMs = Date.now() - 48 * 60 * 60 * 1000;

  for (const q of queries) {
    const articles = await fetchGoogleNewsRss(encodeURIComponent(q), cutoffMs);
    if (articles.length > 0) return articles;
  }

  // No specific news found — fall back to general crypto market headlines
  return fetchGoogleNewsRss(encodeURIComponent("crypto market"), cutoffMs);
}

async function fetchGoogleNewsRss(encodedQuery: string, cutoffMs: number): Promise<NewsArticle[]> {
  try {
    const resp = await fetch(
      `https://news.google.com/rss/search?q=${encodedQuery}&hl=en-US&gl=US&ceid=US:en`,
      { headers: { Accept: "application/xml" }, signal: AbortSignal.timeout(6000) }
    );
    if (!resp.ok) return [];

    const xml = await resp.text();
    const articles: NewsArticle[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    let idx = 0;

    while ((match = itemRegex.exec(xml)) !== null && idx < 8) {
      const item = match[1];
      const title = (item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "")
        .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1").trim();
      const pubDate = (item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? "").trim();
      const source = (item.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] ?? "")
        .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1").trim();

      const publishedAt = pubDate ? new Date(pubDate).getTime() : Date.now();
      if (publishedAt < cutoffMs) continue;

      if (title) {
        articles.push({ title, source, publishedAt, sentiment: scoreSentiment(title) });
      }
      idx++;
    }

    return articles;
  } catch {
    return [];
  }
}

interface CoinbaseTicker {
  price: number;
  volume24h: number;
  priceChange24h: number;  // percentage
}

/** Fetch 24h stats from Coinbase public REST API (no auth needed). */
async function fetchTicker(cbSymbol: string): Promise<CoinbaseTicker | null> {
  try {
    const resp = await fetch(
      `https://api.coinbase.com/api/v3/brokerage/market/products/${cbSymbol}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!resp.ok) return null;
    const data = await resp.json() as Record<string, string>;
    const price = parseFloat(data.price);
    const volume = parseFloat(data.volume_24h);
    const change = parseFloat(data.price_percentage_change_24h);
    if (isNaN(price) || isNaN(volume)) return null;
    return { price, volume24h: volume, priceChange24h: isNaN(change) ? 0 : change };
  } catch {
    return null;
  }
}

/** Compute RSI-14 from the last 20 hourly Coinbase candles. */
async function fetchRSI(cbSymbol: string): Promise<number | null> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const start = now - 22 * 3600;
    const resp = await fetch(
      `https://api.coinbase.com/api/v3/brokerage/market/products/${cbSymbol}/candles?start=${start}&end=${now}&granularity=ONE_HOUR`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!resp.ok) return null;
    const data = await resp.json() as { candles?: Array<{ close: string }> };
    const candles = (data.candles ?? []).slice().reverse(); // oldest first
    if (candles.length < 15) return null;

    const closes = candles.map(c => parseFloat(c.close));
    const changes = closes.slice(1).map((c, i) => c - closes[i]);
    const gains = changes.map(c => c > 0 ? c : 0);
    const losses = changes.map(c => c < 0 ? -c : 0);

    let avgGain = gains.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
    let avgLoss = losses.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
    for (let i = 14; i < changes.length; i++) {
      avgGain = (avgGain * 13 + gains[i]) / 14;
      avgLoss = (avgLoss * 13 + losses[i]) / 14;
    }
    if (avgLoss === 0) return 100;
    return Math.round(100 - 100 / (1 + avgGain / avgLoss));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Indicator colour helpers
// ---------------------------------------------------------------------------

function emojiChange(pct: number): string {
  if (pct > 10) return "💚";
  if (pct > 3)  return "🟢";
  if (pct > 0)  return "🟡";
  if (pct > -3) return "🟠";
  return "🔴";
}

function emojiBook(score: number | null): string {
  if (score === null) return "⚫";
  if (score >= 3)  return "💚";
  if (score >= 1)  return "🟢";
  if (score === 0) return "🟡";
  if (score >= -2) return "🟠";
  return "🔴";
}

function emojiNews(net: number): string {
  if (net >= 3)  return "💚";
  if (net >= 1)  return "🟢";
  if (net === 0) return "🟡";
  if (net >= -2) return "🟠";
  return "🔴";
}

function emojiRSI(rsi: number | null): string {
  if (rsi === null) return "⚫";
  if (rsi > 75) return "🔴"; // very overbought
  if (rsi > 65) return "🟠"; // overbought
  if (rsi >= 45) return "🟢"; // healthy
  if (rsi >= 30) return "🟡"; // weak
  return "💙";                 // oversold — potential reversal
}

function emojiSignal(label: string, rsi: number | null): string {
  if (label === "Strong Buy") return (rsi !== null && rsi > 70) ? "💚" : "🚀";
  if (label === "Buy More")   return "💚";
  if (label === "Hold")       return "🟢";
  if (label === "Caution")    return "🟠";
  return "🔴";
}

interface GainerEntry {
  symbol: string;   // e.g. "BTC-USD"
}

/**
 * Fetch top gainers from the Coinbase public products API.
 * Returns entries sorted by 24h price change descending.
 */
async function fetchTopGainers(topN: number): Promise<GainerEntry[]> {
  try {
    const productsResp = await fetch(
      "https://api.coinbase.com/api/v3/brokerage/market/products?product_type=SPOT&limit=500",
      { signal: AbortSignal.timeout(8000) }
    );
    if (!productsResp.ok) return [];
    const productsData = await productsResp.json() as { products?: Array<Record<string, string>> };
    const products = productsData.products ?? [];

    // Filter + sort to get the top N candidates first
    const candidates = products
      .filter(p =>
        p.status === "online" &&
        !p.is_disabled &&
        !p.trading_disabled &&
        p.product_id.endsWith("-USD") &&   // strict USD pairs only — excludes USDC, USDT
        p.product_type === "SPOT"
      )
      .map(p => ({
        symbol: p.product_id,
        base: (p.base_display_symbol || p.product_id.split("-")[0]).toUpperCase(),
        change: parseFloat(p.price_percentage_change_24h ?? "0"),
        volume: parseFloat(p.approximate_quote_24h_volume ?? "0"),
      }))
      .filter(p => !isNaN(p.change) && p.volume >= MIN_VOLUME_USD);

    candidates.sort((a, b) => b.change - a.change);

    return candidates.slice(0, topN).map(p => ({ symbol: p.symbol }));
  } catch {
    return [];
  }
}

/**
 * Derive a recommendation from news score, book score, and volume change.
 *
 * Weights:
 *   - News net score   (bullish - bearish headlines)
 *   - Book score       (-4 to +4, from scoreBook)
 *   - Volume surge     (+1 if volume ≥ 150% of typical / 24h change > 50%)
 */
function deriveRecommendation(
  newsNet: number,
  book: BookScore | null,
  priceChange24h: number,
): { label: string; emoji: string } {
  const bookPts = book ? book.score : 0;
  // Combined signal: weight book double since it's real-time
  const combined = newsNet + bookPts * 2;

  if (combined >= 5 && bookPts >= 1) return { label: "Strong Buy", emoji: "🚀" };
  if (combined >= 2 && bookPts >= 0) return { label: "Buy More", emoji: "🟢" };
  if (combined >= 0 && priceChange24h >= 0) return { label: "Hold", emoji: "🟡" };
  if (combined < 0 && bookPts < 0) return { label: "Caution", emoji: "🔴" };
  return { label: "Hold", emoji: "🟡" };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function runNewsMonitor(
  progress?: (msg: string) => Promise<void>
): Promise<void> {
  const report = async (msg: string) => {
    logger.info(msg);
    if (progress) await progress(msg).catch(() => {});
  };

  const db = getFirestore();
  await report("[NEWS_MONITOR] Starting run");

  const tradingConfig = await getTradingConfig();
  const symbolSet = new Set<string>();

  // Build a normalised set of allowed symbols for the coinbase broker
  // allowedSymbols are stored as "BTCUSD" — normalise to "BTC-USD" for comparison
  const rawAllowed: string[] = tradingConfig.brokerSettings?.coinbase?.allowedSymbols ?? [];
  const allowedSet = new Set(
    rawAllowed.map(s => {
      // Already has a dash (e.g. "BTC-USD") → keep as-is
      if (s.includes("-")) return s.toUpperCase();
      // Stored without dash (e.g. "BTCUSD") → insert dash before "USD"
      const m = s.toUpperCase().match(/^(.+?)(USD[CT]?)$/);
      return m ? `${m[1]}-${m[2]}` : s.toUpperCase();
    })
  );

  // --- 1. Top gainers from Coinbase ---
  // All top gainers are auto-added to allowedSymbols in Firestore.
  await report(`[NEWS_MONITOR] Fetching top ${TOP_GAINERS_COUNT} gainers from Coinbase...`);
  try {
    const gainers = await fetchTopGainers(TOP_GAINERS_COUNT);
    if (gainers.length === 0) {
      await report("[NEWS_MONITOR] Could not fetch gainers");
    } else {
      // Auto-add gainers to the Coinbase allowedSymbols in Firestore
      const toStorageFormat = (s: string) => s.replace("-", "");
      const newSymbols = gainers.map(g => toStorageFormat(g.symbol));
      const existingAllowed = tradingConfig.brokerSettings?.coinbase?.allowedSymbols ?? [];
      const mergedAllowed = Array.from(new Set([...existingAllowed, ...newSymbols]));
      if (mergedAllowed.length !== existingAllowed.length) {
        try {
          const CONFIG_DOC = db.collection("config").doc("trading");
          await CONFIG_DOC.set({
            brokerSettings: {
              ...(tradingConfig.brokerSettings ?? {}),
              coinbase: {
                ...(tradingConfig.brokerSettings?.coinbase ?? {}),
                allowedSymbols: mergedAllowed,
              },
            },
          }, { merge: true });
          newSymbols.forEach(s => {
            const m = s.match(/^(.+?)(USD[CT]?)$/);
            allowedSet.add(m ? `${m[1]}-${m[2]}` : s);
          });
          await report(`[NEWS_MONITOR] Auto-added to allowlist: ${newSymbols.join(", ")}`);
        } catch (err) {
          logger.warn("[NEWS_MONITOR] Could not update allowedSymbols", { error: String(err) });
        }
      }
      gainers.forEach(g => symbolSet.add(g.symbol));
      await report(`[NEWS_MONITOR] Gainers: ${gainers.map(g => g.symbol).join(", ")}`);
    }
  } catch (err) {
    logger.warn("[NEWS_MONITOR] fetchTopGainers failed", { error: String(err) });
  }

  // --- 2. Always include open positions so held coins are checked ---
  try {
    const broker = getBroker(tradingConfig.ACTIVE_BROKER);
    if (broker.getDetailedPositions) {
      const positions = await Promise.race([
        broker.getDetailedPositions!(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("positions timeout")), 8000)
        ),
      ]);
      for (const pos of positions) {
        symbolSet.add(normalizeBookSymbol(pos.symbol.toUpperCase()));
      }
    }
  } catch (err) {
    logger.warn("[NEWS_MONITOR] Could not fetch positions (non-fatal)", { error: String(err) });
  }

  // --- 3. Fallback: recent BUY signals if nothing found yet ---
  if (symbolSet.size === 0) {
    const cutoff = Timestamp.fromDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
    try {
      const snap = await db.collection("signals").orderBy("createdAt", "desc").limit(50).get();
      for (const doc of snap.docs) {
        const d = doc.data();
        const createdMs = (d.createdAt as Timestamp)?.toMillis?.() ?? 0;
        if (createdMs < cutoff.toMillis()) continue;
        if (d.action !== "BUY") continue;
        if (!["PENDING", "APPROVED", "EXECUTED"].includes(d.status)) continue;
        if (d.symbol) symbolSet.add((d.symbol as string).toUpperCase());
      }
    } catch (err) {
      logger.warn("[NEWS_MONITOR] Could not query signals", { error: String(err) });
    }
  }

  if (symbolSet.size === 0) {
    await report("[NEWS_MONITOR] No symbols found to analyse");
    return;
  }

  const symbols = Array.from(symbolSet);
  await report(`[NEWS_MONITOR] Analysing ${symbols.length} symbol(s): ${symbols.join(", ")}`);

  // --- 3. Fetch news, book, and ticker for each symbol in parallel ---
  interface SymbolData {
    symbol: string;
    cbSymbol: string;
    news: NewsArticle[];
    book: BookScore | null;
    ticker: CoinbaseTicker | null;
    rsi: number | null;
    newsNet: number;
    bullish: number;
    bearish: number;
  }

  const dataList: SymbolData[] = [];

  // Process in batches of 10 to avoid Coinbase rate limits (book+ticker+RSI = 3 req × 10 = 30 max)
  const BATCH = 10;
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    const batchResults = await Promise.all(
      batch.map(async (symbol): Promise<SymbolData> => {
        const cbSymbol = normalizeBookSymbol(symbol);

        const perSymbolTimeout = <T>(p: Promise<T>, fallback: T, label: string): Promise<T> =>
          Promise.race([
            p,
            new Promise<T>(res => setTimeout(() => {
              logger.warn(`[NEWS_MONITOR] Timeout: ${label} for ${symbol}`);
              res(fallback);
            }, 8_000)),
          ]);

        const [bookRaw, ticker, rsi] = await Promise.all([
          perSymbolTimeout(fetchOrderBook(cbSymbol), null, `book`),
          perSymbolTimeout(fetchTicker(cbSymbol), null, `ticker`),
          perSymbolTimeout(fetchRSI(cbSymbol), null, `rsi`),
        ]);

        const book = bookRaw ? scoreBook(bookRaw.bids, bookRaw.asks) : null;

        return { symbol, cbSymbol, news: [], book, ticker, rsi, newsNet: 0, bullish: 0, bearish: 0 };
      })
    );
    dataList.push(...batchResults);
    // Small pause between batches to respect Coinbase rate limits
    if (i + BATCH < symbols.length) await new Promise(r => setTimeout(r, 300));
  }

  // --- 4. Sort: combined score descending ---
  dataList.sort((a, b) => {
    const scoreA = a.newsNet + (a.book?.score ?? 0) * 2;
    const scoreB = b.newsNet + (b.book?.score ?? 0) * 2;
    return scoreB - scoreA;
  });

  // --- 4b. Persist snapshot to Firestore & get iteration counter ---
  const RUNS_COL = "_news_monitor_runs";
  const COUNTER_DOC = db.collection("_news_monitor_meta").doc("counter");

  // Atomically increment iteration counter
  let iteration = 1;
  try {
    const counterSnap = await COUNTER_DOC.get();
    iteration = ((counterSnap.data()?.iteration as number) ?? 0) + 1;
    await COUNTER_DOC.set({ iteration }, { merge: true });
  } catch (err) {
    logger.warn("[NEWS_MONITOR] Could not update counter", { error: String(err) });
  }

  // Store per-symbol snapshot for this run
  const snapshot = dataList.map(d => ({
    symbol: d.symbol,
    bookScore: d.book?.score ?? null,
    rsi: d.rsi,
    priceChange24h: d.ticker?.priceChange24h ?? null,
    volume24h: d.ticker?.volume24h ?? null,
    combinedScore: d.newsNet + (d.book?.score ?? 0) * 2,
  }));

  try {
    await db.collection(RUNS_COL).add({
      runAt: Timestamp.now(),
      iteration,
      symbols: snapshot,
    });
  } catch (err) {
    logger.warn("[NEWS_MONITOR] Could not persist run snapshot", { error: String(err) });
  }

  // --- 4c. Every 3rd run: trend analysis over last 10 snapshots ---
  if (iteration % 3 === 0) {
    try {
      // Fetch last 10 runs
      const runsSnap = await db.collection(RUNS_COL)
        .orderBy("runAt", "desc")
        .limit(10)
        .get();

      // Aggregate scores per symbol across runs
      const symbolHistory: Record<string, number[]> = {};
      const symbolRSI: Record<string, number[]> = {};
      const symbolChange: Record<string, number[]> = {};
      const symbolVolume: Record<string, number[]> = {};
      for (const doc of runsSnap.docs) {
        const run = doc.data() as { symbols: typeof snapshot };
        for (const s of run.symbols ?? []) {
          if (s.combinedScore !== null && s.combinedScore !== undefined) {
            (symbolHistory[s.symbol] ||= []).push(s.combinedScore);
          }
          if (s.rsi !== null && s.rsi !== undefined) {
            (symbolRSI[s.symbol] ||= []).push(s.rsi);
          }
          if (s.priceChange24h !== null && s.priceChange24h !== undefined) {
            (symbolChange[s.symbol] ||= []).push(s.priceChange24h);
          }
          if ((s as any).volume24h !== null && (s as any).volume24h !== undefined) {
            (symbolVolume[s.symbol] ||= []).push((s as any).volume24h as number);
          }
        }
      }

      // Build trend entries — only symbols seen in >= 2 runs
      interface TrendEntry {
        symbol: string;
        avgScore: number;
        trend: number;    // last score minus first score in window
        avgRSI: number | null;
        avgChange: number | null;
        volTrendPct: number | null;
        appearances: number;
      }

      const trendEntries: TrendEntry[] = Object.entries(symbolHistory)
        .filter(([, scores]) => scores.length >= 2)
        .map(([symbol, scores]) => {
          const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
          const trend = scores[0] - scores[scores.length - 1]; // recent minus oldest
          const rsiArr = symbolRSI[symbol] ?? [];
          const chgArr = symbolChange[symbol] ?? [];
          const volArr = symbolVolume[symbol] ?? [];
          // Volume trend: % change from oldest to newest snapshot
          const volTrendPct = volArr.length >= 2
            ? ((volArr[0] - volArr[volArr.length - 1]) / (volArr[volArr.length - 1] || 1)) * 100
            : null;
          return {
            symbol,
            avgScore,
            trend,
            avgRSI: rsiArr.length ? rsiArr.reduce((a, b) => a + b, 0) / rsiArr.length : null,
            avgChange: chgArr.length ? chgArr.reduce((a, b) => a + b, 0) / chgArr.length : null,
            volTrendPct,
            appearances: scores.length,
          };
        })
        .sort((a, b) => b.avgScore - a.avgScore);

      if (trendEntries.length > 0) {
        const trendTimeStr = new Date().toLocaleString("en-US", {
          month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
        });

        const trendHeader = [
          `📈 *Trend Analysis* — last ${runsSnap.size} runs (${Math.round(runsSnap.size * 10)} min)`,
          `_${trendTimeStr} UTC — every 3rd check_`,
          ``,
          `\`Symbol      AvgScore  Trend  AvgRSI\``,
        ];

        const trendRows = trendEntries.map(e => {
          const sym = e.symbol.replace(/-USD[CT]?$/, "").padEnd(7);
          const avg = (e.avgScore >= 0 ? "+" : "") + e.avgScore.toFixed(1);
          const trendArrow = e.trend > 0.5 ? "📈" : e.trend < -0.5 ? "📉" : "➡️";
          const rsiStr = e.avgRSI !== null ? e.avgRSI.toFixed(0) : "--";
          const chgStr = e.avgChange !== null
            ? (e.avgChange >= 0 ? "+" : "") + e.avgChange.toFixed(1) + "%"
            : "--";
          return `${trendArrow}\`${sym}\` ${avg.padEnd(6)}  ${trendArrow}  ${emojiRSI(e.avgRSI)}${rsiStr}  ${emojiChange(e.avgChange ?? 0)}${chgStr}`;
        });

        const CHUNK_T = 20;
        for (let i = 0; i < trendRows.length; i += CHUNK_T) {
          const part = i === 0
            ? [...trendHeader, ...trendRows.slice(i, i + CHUNK_T)]
            : trendRows.slice(i, i + CHUNK_T);
          await sendTelegramMessage(part.join("\n")).catch(e =>
            logger.warn("[NEWS_MONITOR] Trend Telegram failed", { error: String(e) })
          );
        }

        // Push notification for top 3 symbols
        const top3 = trendEntries.slice(0, 3);
        if (top3.length > 0) {
          const tokensSnap = await db.collection("userTokens").get();
          const tokens: string[] = [];
          tokensSnap.forEach(doc => { if (doc.data().token) tokens.push(doc.data().token); });

          if (tokens.length > 0) {
            const body = top3.map(e => {
              const base = e.symbol.replace(/-USD[CT]?$/, "");
              const chg = e.avgChange !== null ? ` ${e.avgChange >= 0 ? "+" : ""}${e.avgChange.toFixed(1)}%` : "";
              return `${base}${chg}`;
            }).join(" · ");

            const messages = tokens.map(token => ({
              to: token,
              sound: "default" as const,
              title: "🔥 Top Trending Crypto",
              body,
              data: { type: "TREND_ALERT", symbols: top3.map(e => e.symbol) },
            }));

            await fetch("https://exp.host/--/api/v2/push/send", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(messages),
            }).catch(e => logger.warn("[NEWS_MONITOR] Push notification failed", { error: String(e) }));

            logger.info("[NEWS_MONITOR] Push sent for top 3", { symbols: top3.map(e => e.symbol) });
          }
        }
      }
    } catch (err) {
      logger.warn("[NEWS_MONITOR] Trend analysis failed (non-fatal)", { error: String(err) });
    }
  }


  // Legend emojis:
  //   Change : 💚>10% 🟢>3% 🟡>0% 🟠>-3% 🔴≤-3%
  //   Book   : 💚+3/+4  🟢+1/+2  🟡0  🟠-1/-2  🔴-3/-4
  //   News   : 💚≥+3  🟢+1/+2  🟡0  🟠-1/-2  🔴≤-3
  //   RSI    : 💙<30(OS) 🟢45-65 🟠65-75(OB) 🔴>75  ⚫n/a
  //   Signal : 🚀StrongBuy  💚Buy  🟢Hold+  🟡Hold  🟠Caution  🔴Sell

  const now = new Date();
  const timeStr = now.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

  const header = [
    `📊 *News Monitor* — ${dataList.length} symbols`,
    `_${timeStr} UTC_`,
    ``,
    `\`Symbol      24h    Bk  Ns  RSI  →\``,
  ];

  // Build rows — send in batches of 20 to stay under Telegram 4096 char limit
  const rows: string[] = [];
  for (const d of dataList) {
    const rec = deriveRecommendation(d.newsNet, d.book, d.ticker?.priceChange24h ?? 0);
    const change = d.ticker?.priceChange24h ?? 0;
    const changeStr = (change >= 0 ? "+" : "") + change.toFixed(1) + "%";
    const bookScore = d.book?.score ?? null;
    const rsiStr = d.rsi !== null ? String(d.rsi) : "--";
    const sig = emojiSignal(rec.label, d.rsi);
    const sym = d.symbol.replace(/-USD[CT]?$/, "").padEnd(7);
    const chg = (emojiChange(change) + changeStr).padEnd(9);
    const bk  = emojiBook(bookScore) + (bookScore !== null ? (bookScore > 0 ? "+" : "") + bookScore : "--");
    const ns  = emojiNews(d.newsNet) + (d.newsNet > 0 ? "+" : "") + d.newsNet;
    const ri  = emojiRSI(d.rsi) + rsiStr;
    rows.push(`${sig}\`${sym}\` ${chg} ${bk}  ${ns}  ${ri}`);
  }

  // --- Build top-5 summary from current run data ---
  const top5 = dataList.slice(0, 5);
  const summaryLines: string[] = [
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `🏆 *Top 5 Signals*`,
  ];
  for (const d of top5) {
    const rec = deriveRecommendation(d.newsNet, d.book, d.ticker?.priceChange24h ?? 0);
    const base = d.symbol.replace(/-USD[CT]?$/, "");
    const change = d.ticker?.priceChange24h ?? 0;
    const bookScore = d.book?.score ?? null;
    const bookLabel = bookScore !== null ? `${bookScore > 0 ? "+" : ""}${bookScore}` : "n/a";
    const rsiLabel = d.rsi !== null ? String(d.rsi) : "n/a";
    const volLabel = d.ticker?.volume24h
      ? `$${(d.ticker.volume24h / 1_000_000).toFixed(1)}M`
      : "n/a";
    const chgLabel = (change >= 0 ? "+" : "") + change.toFixed(1) + "%";
    summaryLines.push(
      `${emojiSignal(rec.label, d.rsi)} *${base}* — ${rec.label}`,
      `  24h: ${emojiChange(change)}${chgLabel}  Vol: ${volLabel}  Book: ${emojiBook(bookScore)}${bookLabel}  RSI: ${emojiRSI(d.rsi)}${rsiLabel}`,
    );
  }

  // Split table into chunks, attach summary to last chunk
  const CHUNK = 20;
  const parts: string[][] = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    parts.push(rows.slice(i, i + CHUNK));
  }

  for (let i = 0; i < parts.length; i++) {
    const isFirst = i === 0;
    const isLast = i === parts.length - 1;
    const msgParts = [
      ...(isFirst ? [...header] : []),
      ...parts[i],
      ...(isLast ? summaryLines : []),
    ];
    await sendTelegramMessage(msgParts.join("\n")).catch(e =>
      logger.warn("[NEWS_MONITOR] Telegram digest failed", { error: String(e) })
    );
  }

  logger.info("[NEWS_MONITOR] Digest sent");
}
