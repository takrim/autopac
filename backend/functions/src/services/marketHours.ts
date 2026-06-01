/**
 * Returns true when the US stock market is tradeable on Alpaca, i.e. the
 * full extended-hours window: Mon-Fri 04:00-20:00 America/New_York
 * (pre-market 04:00-09:30, regular 09:30-16:00, after-hours 16:00-20:00).
 * Used by the liquidator to decide whether stop-loss updates are worth
 * sending. Does NOT account for holidays; Alpaca will reject/queue orders
 * on those days anyway.
 */
export function isUsStockMarketOpen(now: Date = new Date()): boolean {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 240 && mins < 1200; // 04:00 .. 20:00
}
