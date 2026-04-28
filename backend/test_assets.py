import json, urllib.request

all_assets = []
for page in range(1, 6):
    url = f"https://api.coinbase.com/v2/assets/search?base=USD&filter=listed&limit=100&page={page}"
    req = urllib.request.Request(url, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())
        assets = data.get("data", [])
        if not assets:
            break
        all_assets.extend(assets)

print(f"Total assets: {len(all_assets)}")

sample = all_assets[50]
print(f"Sample ({sample['symbol']}): keys={list(sample.keys())}")
print(f"  website={sample.get('website','N/A')}")
print(f"  description={bool(sample.get('description'))}")

symbols = {a["symbol"] for a in all_assets}
for s in ["TRUMP", "CLANKER", "IP", "BONK", "WIF", "PENGU", "FLOKI", "MOODENG"]:
    if s in symbols:
        asset = next(a for a in all_assets if a["symbol"] == s)
        print(f"{s}: FOUND, image={bool(asset.get('image_url'))}, desc={bool(asset.get('description'))}")
    else:
        print(f"{s}: NOT FOUND")
