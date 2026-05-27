/**
 * Unit tests for the burst-scanner symbol caches.
 *
 * These tests lock in the two bugs that were fixed in commit history:
 *   1. Dotted-key writes: `set({"symbols.K": v}, {merge:true})` was creating literal
 *      top-level fields named "symbols.K" instead of nested map entries, so cache reads
 *      always returned an empty Set.
 *   2. Lazy GC using `FieldValue.delete()` with dotted keys via `set({merge:true})` —
 *      same field-path problem. We now rewrite the `symbols` map wholesale instead.
 *   3. Zero-candle skip-reason detection regex used to mark a symbol as not-on-Coinbase.
 */

import type { DocumentReference } from "firebase-admin/firestore";

// Mock firebase-functions logger before importing the module under test.
jest.mock("firebase-functions/v2", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  loadSymbolCache,
  addToSymbolCache,
  ZERO_CANDLES_SKIP_REGEX,
} from "../src/services/burstScannerCache";

// -- in-memory fake DocumentReference --------------------------------------

interface SetCall {
  data: any;
  options?: { merge?: boolean };
}

class FakeDoc {
  exists = false;
  data: any = undefined;
  setCalls: SetCall[] = [];
  getError: Error | null = null;

  async get() {
    if (this.getError) throw this.getError;
    return {
      exists: this.exists,
      data: () => this.data,
    };
  }

  async set(data: any, options?: { merge?: boolean }) {
    this.setCalls.push({ data, options });
    if (options?.merge) {
      // Deep-merge nested objects one level (sufficient for { symbols: { ... } }).
      this.data = this.data ?? {};
      for (const [k, v] of Object.entries(data)) {
        if (v && typeof v === "object" && !Array.isArray(v) && this.data[k] && typeof this.data[k] === "object") {
          this.data[k] = { ...this.data[k], ...(v as object) };
        } else {
          this.data[k] = v;
        }
      }
    } else {
      this.data = data;
    }
    this.exists = true;
  }

  asRef(): DocumentReference {
    return this as unknown as DocumentReference;
  }
}

const TTL = 1000 * 60 * 60; // 1h for tests

describe("burstScannerCache", () => {
  describe("addToSymbolCache", () => {
    test("writes a NESTED { symbols: {…} } object — NOT dotted keys", async () => {
      const doc = new FakeDoc();
      await addToSymbolCache(doc.asRef(), ["EDGE-USD", "UB-USD"], "test");

      expect(doc.setCalls).toHaveLength(1);
      const call = doc.setCalls[0];
      expect(call.options).toEqual({ merge: true });

      // The write payload MUST have a top-level `symbols` field that is an object,
      // not literal "symbols.EDGE-USD" / "symbols.UB-USD" fields.
      expect(call.data).toHaveProperty("symbols");
      expect(typeof call.data.symbols).toBe("object");
      expect(call.data.symbols["EDGE-USD"]).toEqual(expect.any(Number));
      expect(call.data.symbols["UB-USD"]).toEqual(expect.any(Number));

      // Negative guard against regression: NO top-level dotted keys.
      for (const key of Object.keys(call.data)) {
        expect(key.includes(".")).toBe(false);
      }
    });

    test("empty list is a no-op (no Firestore call)", async () => {
      const doc = new FakeDoc();
      await addToSymbolCache(doc.asRef(), [], "test");
      expect(doc.setCalls).toHaveLength(0);
    });

    test("swallows Firestore errors (non-fatal)", async () => {
      const doc = new FakeDoc();
      doc.set = async () => { throw new Error("boom"); };
      await expect(addToSymbolCache(doc.asRef(), ["X-USD"], "test")).resolves.toBeUndefined();
    });
  });

  describe("loadSymbolCache", () => {
    test("returns empty Set when doc does not exist", async () => {
      const doc = new FakeDoc();
      const result = await loadSymbolCache(doc.asRef(), TTL, "test");
      expect(result.size).toBe(0);
    });

    test("returns valid (non-expired) symbols and excludes expired ones", async () => {
      const doc = new FakeDoc();
      const now = Date.now();
      doc.exists = true;
      doc.data = {
        symbols: {
          "FRESH-USD": now - 1000,          // 1s ago → valid
          "STALE-USD": now - (TTL + 5000),  // older than TTL → expired
        },
      };

      const result = await loadSymbolCache(doc.asRef(), TTL, "test");
      expect(result.has("FRESH-USD")).toBe(true);
      expect(result.has("STALE-USD")).toBe(false);
    });

    test("lazy GC rewrites symbols map WITHOUT merge and WITHOUT dotted keys", async () => {
      const doc = new FakeDoc();
      const now = Date.now();
      doc.exists = true;
      doc.data = {
        symbols: {
          "FRESH-USD": now - 1000,
          "STALE-USD": now - (TTL + 5000),
        },
      };

      await loadSymbolCache(doc.asRef(), TTL, "test");

      // Exactly one rewrite triggered by GC.
      expect(doc.setCalls).toHaveLength(1);
      const call = doc.setCalls[0];

      // Wholesale rewrite — no merge.
      expect(call.options?.merge).toBeFalsy();

      // Payload must be nested { symbols: { FRESH-USD: <ts> } } with STALE removed.
      expect(call.data).toEqual({ symbols: { "FRESH-USD": expect.any(Number) } });
      expect(call.data.symbols).not.toHaveProperty("STALE-USD");

      // Negative guard: no top-level dotted keys, no FieldValue.delete sentinels.
      for (const key of Object.keys(call.data)) expect(key.includes(".")).toBe(false);
    });

    test("does not write when nothing expired", async () => {
      const doc = new FakeDoc();
      const now = Date.now();
      doc.exists = true;
      doc.data = { symbols: { "A-USD": now, "B-USD": now } };

      await loadSymbolCache(doc.asRef(), TTL, "test");
      expect(doc.setCalls).toHaveLength(0);
    });

    test("ignores non-numeric timestamps", async () => {
      const doc = new FakeDoc();
      doc.exists = true;
      doc.data = { symbols: { "BAD-USD": "not-a-number" as any, "GOOD-USD": Date.now() } };

      const result = await loadSymbolCache(doc.asRef(), TTL, "test");
      expect(result.has("BAD-USD")).toBe(false);
      expect(result.has("GOOD-USD")).toBe(true);
    });

    test("returns empty Set when .get() throws (does not propagate)", async () => {
      const doc = new FakeDoc();
      doc.getError = new Error("network");
      const result = await loadSymbolCache(doc.asRef(), TTL, "test");
      expect(result.size).toBe(0);
    });
  });

  describe("round-trip (regression for dotted-key bug)", () => {
    test("write then read returns the same symbols", async () => {
      const doc = new FakeDoc();
      await addToSymbolCache(doc.asRef(), ["EDGE-USD", "UB-USD"], "test");
      const loaded = await loadSymbolCache(doc.asRef(), TTL, "test");

      expect(loaded.has("EDGE-USD")).toBe(true);
      expect(loaded.has("UB-USD")).toBe(true);
      expect(loaded.size).toBe(2);
    });

    test("subsequent writes merge with existing symbols (no clobber)", async () => {
      const doc = new FakeDoc();
      await addToSymbolCache(doc.asRef(), ["A-USD"], "test");
      await addToSymbolCache(doc.asRef(), ["B-USD"], "test");
      const loaded = await loadSymbolCache(doc.asRef(), TTL, "test");

      expect(loaded.has("A-USD")).toBe(true);
      expect(loaded.has("B-USD")).toBe(true);
    });
  });

  describe("ZERO_CANDLES_SKIP_REGEX", () => {
    test("matches the not-on-Coinbase skip-reason strings", () => {
      expect(ZERO_CANDLES_SKIP_REGEX.test("RSI unavailable on 3m and 5m (only 0 3m bars)")).toBe(true);
      expect(ZERO_CANDLES_SKIP_REGEX.test("RSI unavailable on 3m and 5m (only 0 5m bars)")).toBe(true);
    });

    test("does NOT match thin-data skip strings where bars > 0", () => {
      expect(ZERO_CANDLES_SKIP_REGEX.test("RSI unavailable on 3m and 5m (only 5 3m bars)")).toBe(false);
      expect(ZERO_CANDLES_SKIP_REGEX.test("RSI unavailable on 3m and 5m (only 10 5m bars)")).toBe(false);
    });

    test("does NOT match unrelated skip strings", () => {
      expect(ZERO_CANDLES_SKIP_REGEX.test("below 200-EMA on 1h (downtrend)")).toBe(false);
      expect(ZERO_CANDLES_SKIP_REGEX.test("RSI 65 ≥ 60 (not oversold)")).toBe(false);
    });
  });
});
