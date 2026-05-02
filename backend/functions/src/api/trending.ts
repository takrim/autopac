import { Request, Response } from "express";
import { logger } from "firebase-functions/v2";
import { getTradingConfig } from "./config";
import { getAlpacaConfig } from "../config";

const COINBASE_PRODUCTS_URL = "https://api.coinbase.com/api/v3/brokerage/market/products";
const COINBASE_ASSETS_SEARCH_URL = "https://api.coinbase.com/v2/assets/search";

interface CoinbaseProduct {
  product_id: string;
  price: string;
  price_percentage_change_24h: string;
  volume_24h: string;
  volume_percentage_change_24h: string;
  base_name: string;
  quote_name: string;
  base_display_symbol: string;
  quote_display_symbol: string;
  base_currency_id: string;
  status: string;
  is_disabled: boolean;
  trading_disabled: boolean;
  product_type: string;
  approximate_quote_24h_volume: string;
}

interface CoinbaseAsset {
  id: string;
  symbol: string;
  name: string;
  slug: string;
  color: string;
  image_url: string;
  description: string;
  website: string;
  asset_type: string;
  asset_type_description: string;
  launched_at: string;
  resource_urls?: { type: string; link: string }[];
}

export interface TrendingCrypto {
  symbol: string;
  name: string;
  price: number;
  priceChange24h: number;
  volume24h: number;
  volumeChange24h: number;
  quoteVolume24h: number;
  color: string;
  imageUrl: string;
  description: string;
  website: string;
  assetType: string;
  launchedAt: string;
}

// Simple in-memory cache to avoid hammering Coinbase on every request
let cachedTrending: { data: TrendingCrypto[]; timestamp: number } | null = null;
let cachedStocksTrending: { data: TrendingCrypto[]; timestamp: number } | null = null;
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

const ALPACA_DATA_URL = "https://data.alpaca.markets";

const POPULAR_STOCKS = [
  "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "AVGO", "JPM", "LLY",
  "V", "UNH", "XOM", "MA", "HD", "PG", "COST", "JNJ", "ABBV", "MRK",
  "CVX", "BAC", "CRM", "WMT", "KO", "PEP", "TMO", "ACN", "MCD", "AMD",
  "NFLX", "ORCL", "LIN", "TXN", "INTC", "AMGN", "COP", "CAT", "INTU",
  "NOW", "SPGI", "GS", "BLK", "SBUX", "UBER", "SHOP", "PLTR", "ARM", "SOFI",
];

interface AlpacaSnapshot {
  latestTrade?: { p: number };
  dailyBar?: { c: number; h: number; l: number; o: number; v: number; vw: number };
  prevDailyBar?: { c: number; v: number; vw: number };
}

/**
 * GET /trending — Returns top trending crypto sorted by 24h price change.
 * Uses Coinbase public APIs (Products + Assets) regardless of active broker.
 *
 * Query params:
 *   ?sort=price_change|volume_change|volume  (default: price_change)
 *   ?limit=25                                 (default: 25, max 100)
 *   ?quote=USD                                (default: USD)
 */
export async function handleGetTrending(req: Request, res: Response): Promise<void> {
  const sort = (req.query.sort as string) || "price_change";
  const limit = Math.min(parseInt(req.query.limit as string) || 25, 100);
  const quote = ((req.query.quote as string) || "USD").toUpperCase();

  try {
    const tradingConfig = await getTradingConfig();

    // --- Stocks mode (Alpaca) ---
    if (tradingConfig.ACTIVE_BROKER === "alpaca") {
      const now = Date.now();
      if (cachedStocksTrending && now - cachedStocksTrending.timestamp < CACHE_TTL_MS) {
        const sorted = sortTrending(cachedStocksTrending.data, sort, quote);
        res.json({ trending: sorted.slice(0, limit), cached: true });
        return;
      }
      const stocks = await fetchAlpacaStocks();
      cachedStocksTrending = { data: stocks, timestamp: now };
      const sorted = sortTrending(stocks, sort, quote);
      res.json({ trending: sorted.slice(0, limit), cached: false });
      return;
    }

    // --- Crypto mode (Coinbase) ---
    const now = Date.now();

    // Return cached data if fresh
    if (cachedTrending && now - cachedTrending.timestamp < CACHE_TTL_MS) {
      const sorted = sortTrending(cachedTrending.data, sort, quote);
      res.json({ trending: sorted.slice(0, limit), cached: true });
      return;
    }

    // Fetch products and assets in parallel
    const [products, assets] = await Promise.all([
      fetchCoinbaseProducts(),
      fetchCoinbaseAssets(),
    ]);

    // Build asset lookup by symbol
    const assetMap = new Map<string, CoinbaseAsset>();
    for (const asset of assets) {
      assetMap.set(asset.symbol, asset);
    }

    // Merge products with asset metadata
    const trending: TrendingCrypto[] = [];
    for (const product of products) {
      // Only include SPOT products trading against USD/USDC
      if (product.product_type !== "SPOT") continue;
      if (product.is_disabled || product.trading_disabled) continue;
      if (product.status !== "online") continue;

      const quoteSymbol = product.quote_display_symbol;
      if (quoteSymbol !== "USD" && quoteSymbol !== "USDC") continue;

      const price = parseFloat(product.price);
      const priceChange = parseFloat(product.price_percentage_change_24h);
      const volume = parseFloat(product.volume_24h);
      const volumeChange = parseFloat(product.volume_percentage_change_24h);
      const quoteVolume = parseFloat(product.approximate_quote_24h_volume);

      if (isNaN(price) || price <= 0) continue;
      if (isNaN(priceChange)) continue;

      const baseSymbol = product.base_display_symbol;
      const asset = assetMap.get(baseSymbol);

      trending.push({
        symbol: product.product_id,
        name: asset?.name || product.base_name || baseSymbol,
        price,
        priceChange24h: priceChange,
        volume24h: isNaN(volume) ? 0 : volume,
        volumeChange24h: isNaN(volumeChange) ? 0 : volumeChange,
        quoteVolume24h: isNaN(quoteVolume) ? 0 : quoteVolume,
        color: asset?.color || "#888",
        imageUrl: asset?.image_url || "",
        description: asset?.description || "",
        website: asset?.website || "",
        assetType: asset?.asset_type_description || product.product_type,
        launchedAt: asset?.launched_at || "",
      });
    }

    // Deduplicate: prefer USD pair over USDC
    const deduped = deduplicateByBase(trending);

    // Cache the full result
    cachedTrending = { data: deduped, timestamp: now };

    const sorted = sortTrending(deduped, sort, quote);
    res.json({ trending: sorted.slice(0, limit), cached: false });
  } catch (err) {
    logger.error("[TRENDING] Failed to fetch trending data", { error: String(err) });
    // Return stale cache if available
    if (cachedTrending) {
      const sorted = sortTrending(cachedTrending.data, sort, quote);
      res.json({ trending: sorted.slice(0, limit), cached: true, stale: true });
      return;
    }
    res.status(500).json({ error: "Failed to fetch trending data" });
  }
}

async function fetchAlpacaStocks(): Promise<TrendingCrypto[]> {
  const alpacaConfig = getAlpacaConfig();
  if (!alpacaConfig.apiKey || !alpacaConfig.apiSecret) {
    throw new Error("Alpaca credentials not configured");
  }

  const headers = {
    "APCA-API-KEY-ID": alpacaConfig.apiKey,
    "APCA-API-SECRET-KEY": alpacaConfig.apiSecret,
    "Content-Type": "application/json",
  };

  // Try screener for live most-actives list; fall back to curated POPULAR_STOCKS
  let symbols = POPULAR_STOCKS;
  try {
    const screenerResp = await fetch(
      `${ALPACA_DATA_URL}/v2/screener/stocks/most-actives?by=volume&top=50`,
      { headers }
    );
    if (screenerResp.ok) {
      const screenerData = await screenerResp.json() as { most_actives?: { symbol: string }[] };
      const screenerSymbols = (screenerData.most_actives || []).map((s) => s.symbol);
      if (screenerSymbols.length >= 10) symbols = screenerSymbols;
    }
  } catch {
    // Fall back to POPULAR_STOCKS
  }

  const symbolsParam = symbols.join(",");
  const snapshotResp = await fetch(
    `${ALPACA_DATA_URL}/v2/stocks/snapshots?symbols=${encodeURIComponent(symbolsParam)}&feed=iex`,
    { headers }
  );
  if (!snapshotResp.ok) {
    throw new Error(`Alpaca snapshots API error: ${snapshotResp.status}`);
  }

  const snapshots = await snapshotResp.json() as Record<string, AlpacaSnapshot>;

  const result: TrendingCrypto[] = [];
  for (const [symbol, snap] of Object.entries(snapshots)) {
    if (!snap.dailyBar || !snap.prevDailyBar) continue;

    const price = snap.latestTrade?.p ?? snap.dailyBar.c;
    const prevClose = snap.prevDailyBar.c;
    const priceChange = prevClose > 0 ? ((snap.dailyBar.c - prevClose) / prevClose) * 100 : 0;
    const quoteVolume = (snap.dailyBar.vw || snap.dailyBar.c) * snap.dailyBar.v;

    result.push({
      symbol,
      name: symbol,
      price,
      priceChange24h: priceChange,
      volume24h: snap.dailyBar.v,
      volumeChange24h: snap.prevDailyBar.v > 0
        ? ((snap.dailyBar.v - snap.prevDailyBar.v) / snap.prevDailyBar.v) * 100
        : 0,
      quoteVolume24h: quoteVolume,
      color: "#2962ff",
      imageUrl: "",
      description: "",
      website: "",
      assetType: "Stock",
      launchedAt: "",
    });
  }
  return result;
}

async function fetchCoinbaseProducts(): Promise<CoinbaseProduct[]> {
  const response = await fetch(`${COINBASE_PRODUCTS_URL}?product_type=SPOT&limit=500`, {
    headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Coinbase Products API error: ${response.status}`);
  }
  const data = await response.json();
  return data.products || [];
}

async function fetchCoinbaseAssets(): Promise<CoinbaseAsset[]> {
  const allAssets: CoinbaseAsset[] = [];
  // Fetch up to 4 pages (100 each) from the search endpoint for ~400 assets
  for (let page = 1; page <= 4; page++) {
    const url = `${COINBASE_ASSETS_SEARCH_URL}?base=USD&filter=listed&limit=100&page=${page}`;
    const response = await fetch(url, {
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
      logger.warn(`[TRENDING] Assets search page ${page} failed: ${response.status}`);
      break;
    }
    const data = await response.json();
    const assets = data.data || [];
    if (assets.length === 0) break;

    for (const raw of assets) {
      // Extract website from resource_urls
      const websiteRes = (raw.resource_urls || []).find(
        (r: { type: string; link: string }) => r.type === "website"
      );
      allAssets.push({
        ...raw,
        website: websiteRes?.link || "",
        asset_type: raw.asset_type || "",
        asset_type_description: raw.asset_type_description || "Cryptocurrency",
      });
    }
  }
  return allAssets;
}

function deduplicateByBase(items: TrendingCrypto[]): TrendingCrypto[] {
  const byBase = new Map<string, TrendingCrypto>();
  for (const item of items) {
    const base = item.symbol.split("-")[0];
    const existing = byBase.get(base);
    // Prefer USD pair over USDC
    if (!existing || item.symbol.endsWith("-USD")) {
      byBase.set(base, item);
    }
  }
  return Array.from(byBase.values());
}

function sortTrending(items: TrendingCrypto[], sort: string, _quote: string): TrendingCrypto[] {
  const sorted = [...items];
  switch (sort) {
    case "volume_change":
      sorted.sort((a, b) => b.volumeChange24h - a.volumeChange24h);
      break;
    case "volume":
      sorted.sort((a, b) => b.quoteVolume24h - a.quoteVolume24h);
      break;
    case "gainers":
      sorted.sort((a, b) => b.priceChange24h - a.priceChange24h);
      break;
    case "losers":
      sorted.sort((a, b) => a.priceChange24h - b.priceChange24h);
      break;
    case "price_change":
    default:
      // Sort by absolute price change (most movement = most trending)
      sorted.sort((a, b) => Math.abs(b.priceChange24h) - Math.abs(a.priceChange24h));
      break;
  }
  return sorted;
}
