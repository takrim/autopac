/**
 * Returns true when the US stock market regular session is currently open
 * (Mon-Fri, 09:30-16:00 America/New_York). Does NOT account for holidays;
 * Alpaca will reject/queue orders on those days anyway.
 */
export function isUsStockMarketOpen(now: Date = new Date()): boolean {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const mins = et.getHours() * 60 + et.getMinutes();
  return mins >= 570 && mins < 960; // 9:30 .. 16:00
}
