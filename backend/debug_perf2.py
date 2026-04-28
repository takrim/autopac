#!/usr/bin/env python3
import sys, json

data = json.load(sys.stdin)
perf = data.get('performance', {})
debug = perf.get('debug', [])

# Check ADA buys vs sells
for item in debug:
    if 'sells' in item and item['productId'] == 'ADA-USD':
        total_buy_qty = sum(b['qty'] for b in item.get('buysData', []))
        total_sell_qty = sum(s['qty'] for s in item.get('sellsData', []))
        total_buy_cost_raw = sum(b['qty'] for b in item.get('buysData', []))
        total_buy_cost_calc = sum(b['qty'] * b['price'] for b in item.get('buysData', []))
        total_sell_revenue = sum(s['qty'] * s['price'] for s in item.get('sellsData', []))
        
        print(f"ADA-USD:")
        print(f"  Total buy 'qty' (raw size): {total_buy_qty:.6f}")
        print(f"  Total buy cost (qty*price): ${total_buy_cost_calc:.4f}")
        print(f"  Total sell 'qty' (raw size): {total_sell_qty:.6f}")  
        print(f"  Total sell revenue (qty*price): ${total_sell_revenue:.4f}")
        print(f"  Current position: 38.77 ADA")
        print()
        
        # Theory: buy 'size' is in USD (quote), not ADA (base)
        total_buy_base_if_quote = sum(b['qty'] / b['price'] for b in item.get('buysData', []))
        print(f"  IF buy qty is USD -> actual ADA bought: {total_buy_base_if_quote:.4f}")
        print(f"  Expected ADA (sold + held): {total_sell_qty + 38.77:.4f}")
        print()
        
        # Same for ETH
    if 'sells' in item and item['productId'] == 'ETH-USD':
        total_buy_qty = sum(b['qty'] for b in item.get('buysData', []))
        total_sell_qty = sum(s['qty'] for s in item.get('sellsData', []))
        total_buy_base_if_quote = sum(b['qty'] / b['price'] for b in item.get('buysData', []))
        print(f"ETH-USD:")
        print(f"  Total buy 'qty' (raw size): {total_buy_qty:.8f}")
        print(f"  Total sell 'qty' (raw size): {total_sell_qty:.8f}")
        print(f"  IF buy qty is USD -> actual ETH bought: {total_buy_base_if_quote:.8f}")
        print(f"  Current position: 0.00013188 ETH")
        print(f"  Expected ETH (sold + held): {total_sell_qty + 0.00013188:.8f}")
        print()

    if 'sells' in item and item['productId'] == 'DOT-USD':
        total_buy_qty = sum(b['qty'] for b in item.get('buysData', []))
        total_sell_qty = sum(s['qty'] for s in item.get('sellsData', []))
        total_buy_base_if_quote = sum(b['qty'] / b['price'] for b in item.get('buysData', []))
        print(f"DOT-USD:")
        print(f"  Total buy 'qty' (raw size): {total_buy_qty:.8f}")
        print(f"  Total sell 'qty' (raw size): {total_sell_qty:.8f}")
        print(f"  IF buy qty is USD -> actual DOT bought: {total_buy_base_if_quote:.8f}")
        print(f"  Current position: 0 DOT (closed)")
        print(f"  Expected DOT (sold + held): {total_sell_qty:.8f}")
