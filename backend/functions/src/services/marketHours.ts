/**
 * Returns true when US stocks are tradeable on Alpaca, including the 24/5
 * overnight session.
 *
 * Alpaca schedule (America/New_York):
 *   - Regular + extended day:  Mon–Fri 04:00–20:00
 *   - Overnight session:       Sun 20:00 → Fri 04:00  (limit DAY orders with
 *                              extended_hours=true; only `overnight_tradable`
 *                              NMS symbols are eligible)
 *
 * Combined, equities are tradeable continuously from Sunday 20:00 ET to Friday
 * 20:00 ET. Saturday (and Sunday before 20:00) are closed. Does NOT account for
 * market holidays; Alpaca will reject/queue orders on those days anyway.
 */
export function isUsStockMarketOpen(now: Date = new Date()): boolean {
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay(); // 0=Sun … 6=Sat
  const mins = et.getHours() * 60 + et.getMinutes();
  if (day === 6) return false; // Saturday — closed
  if (day === 0) return mins >= 1200; // Sunday — overnight opens 20:00 ET
  if (day === 5) return mins < 1200; // Friday — closes 20:00 ET (no Fri→Sat overnight)
  return true; // Mon–Thu — tradeable 24h
}
