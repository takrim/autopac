#!/usr/bin/env python3
import sys, json, os
from datetime import datetime

# Read from stdin or curl
data = json.load(sys.stdin)
perf = data.get('performance', {})
debug = perf.get('debug', [])

for item in debug:
    if 'sells' in item:
        print(f"\n--- {item['productId']}: {item['sells']} sells, {item['buys']} buys ---")
        for s in item.get('sellsData', []):
            t = datetime.fromtimestamp(s['time']/1000)
            print(f"  SELL: qty={s['qty']}, price={s['price']}, fee={s['fee']}, time={t}")
        for b in item.get('buysData', []):
            t = datetime.fromtimestamp(b['time']/1000)
            print(f"  BUY:  qty={b['qty']}, price={b['price']}, fee={b['fee']}, time={t}")
    elif item.get('action') == 'sell_match':
        print(f"  MATCH {item['productId']}: sellQty={item['sellQty']:.6f} @ {item['sellPrice']:.4f}")
        print(f"    revenue={item['sellRevenue']:.4f}, buyCost={item['buyCost']:.4f}, REALIZED={item['realizedPl']:.4f}")
        for m in item.get('matchLog', []):
            print(f"    -> matched={m['matchQty']:.6f} @ buyPrice={m['buyPrice']:.4f}, cost={m['matchCost']:.4f}, buyIdx={m['buyIdx']}")

print("\n=== SUMMARY ===")
for k in ['1d','1w','1m','1y']:
    info = perf.get(k, {})
    print(f"  {k}: P&L=${info.get('realizedPl',0):.4f}, trades={info.get('trades',0)}")
