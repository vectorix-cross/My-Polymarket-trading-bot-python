import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import { WhaleDB } from '../src/whales/whale_db';
import { WhaleScanner } from '../src/whales/whale_scanner';
import {
  DEFAULT_WHALE_CONFIG,
  type WhaleTrackingConfig,
  type ScannerConfig,
} from '../src/whales/whale_types';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Test helpers
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const TEST_DB_PATH = path.join(__dirname, '.test_scanner.db');

function makeScannerConfig(overrides: Partial<ScannerConfig> = {}): ScannerConfig {
  return {
    ...DEFAULT_WHALE_CONFIG.scanner,
    scanIntervalMs: 999_999_999, // don't auto-cycle during tests
    ...overrides,
  };
}

function makeConfig(scannerOverrides: Partial<ScannerConfig> = {}): WhaleTrackingConfig {
  return {
    ...DEFAULT_WHALE_CONFIG,
    dbPath: TEST_DB_PATH,
    scanner: makeScannerConfig(scannerOverrides),
  };
}

/* ── Fake Gamma response ── */
function gammaMarkets(count = 3) {
  return Array.from({ length: count }, (_, i) => ({
    id: `market_${i}`,
    conditionId: `0xcond_market_${i}`,
    question: `Will event ${i} happen?`,
    slug: `event-${i}`,
    outcomes: JSON.stringify(['Yes', 'No']),
    outcomePrices: JSON.stringify([0.65, 0.35]),
    clobTokenIds: JSON.stringify([`tok_${i}_yes`, `tok_${i}_no`]),
    volume24hr: 100_000 - i * 10_000,
    liquidityNum: 50_000 - i * 5_000,
    active: true,
    closed: false,
    acceptingOrders: true,
  }));
}

/* ── Fake data-api trades for a market (matches data-api.polymarket.com shape) ── */
function clobTrades(marketId: string, addressCount = 5, tradesPerAddr = 10) {
  const trades: unknown[] = [];
  const baseTimeSec = Math.floor((Date.now() - 3_600_000) / 1000); // 1 hour ago, epoch seconds
  for (let a = 0; a < addressCount; a++) {
    const addr = `0x${'abcd'.repeat(4)}${a.toString(16).padStart(8, '0')}`;
    for (let t = 0; t < tradesPerAddr; t++) {
      const isBuy = t % 3 !== 0; // ~67% buys
      const price = 0.55 + Math.random() * 0.25;
      const size = 50 + Math.random() * 200;
      trades.push({
        transactionHash: `0xtx_${marketId}_${a}_${t}`,
        proxyWallet: addr,
        asset: `tok_${marketId}_yes`,
        side: isBuy ? 'BUY' : 'SELL',
        size,
        price,
        timestamp: baseTimeSec + t * 60,
        outcome: 'Yes',
        conditionId: `0xcond_${marketId}`,
      });
    }
  }
  return trades;
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Test suite
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

let db: WhaleDB;

beforeEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = new WhaleDB(TEST_DB_PATH);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

describe('WhaleScanner — Lifecycle', () => {
  it('initialises in idle / disabled state', () => {
    const scanner = new WhaleScanner(db, makeConfig(), 'https://gamma.test', 'https://clob.test');
    const state = scanner.getState();
    expect(state.status).toBe('idle');
    expect(state.enabled).toBe(false);
    expect(state.marketsScanned).toBe(0);
    expect(state.lastScanAt).toBeNull();
    expect(state.totalScansCompleted).toBe(0);
  });

  it('start sets enabled=true and status=idle', () => {
    // Stub fetch so the immediate scan in start() doesn't make real requests
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    }));

    const scanner = new WhaleScanner(db, makeConfig(), 'https://gamma.test', 'https://clob.test');
    scanner.start();
    const state = scanner.getState();
    expect(state.enabled).toBe(true);
    // Status might be 'scanning' or 'idle' depending on microtask timing
    expect(['idle', 'scanning']).toContain(state.status);
    scanner.stop();

    vi.unstubAllGlobals();
  });

  it('stop disables and clears state', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    }));

    const scanner = new WhaleScanner(db, makeConfig(), 'https://gamma.test', 'https://clob.test');
    scanner.start();
    scanner.stop();
    const state = scanner.getState();
    expect(state.enabled).toBe(false);
    expect(state.status).toBe('idle');

    vi.unstubAllGlobals();
  });

  it('toggle flips enabled state', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    }));

    const scanner = new WhaleScanner(db, makeConfig(), 'https://gamma.test', 'https://clob.test');
    expect(scanner.isEnabled()).toBe(false);

    scanner.toggle();
    expect(scanner.isEnabled()).toBe(true);

    scanner.toggle();
    expect(scanner.isEnabled()).toBe(false);

    vi.unstubAllGlobals();
  });

  it('getState returns a copy (mutations do not leak)', () => {
    const scanner = new WhaleScanner(db, makeConfig(), 'https://gamma.test', 'https://clob.test');
    const s1 = scanner.getState();
    s1.marketsScanned = 999;
    const s2 = scanner.getState();
    expect(s2.marketsScanned).toBe(0);
  });
});

describe('WhaleScanner — triggerScan (with mock fetch)', () => {
  it('scans markets and profiles addresses', async () => {
    const markets = gammaMarkets(2);
    const trades0 = clobTrades('0xcond_market_0', 3, 8);
    const trades1 = clobTrades('0xcond_market_1', 2, 6);

    let callIndex = 0;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      callIndex++;
      if (url.includes('/markets')) {
        return { ok: true, json: () => Promise.resolve(markets) };
      }
      if (url.includes('market=0xcond_market_0')) {
        return { ok: true, json: () => Promise.resolve(trades0) };
      }
      if (url.includes('market=0xcond_market_1')) {
        return { ok: true, json: () => Promise.resolve(trades1) };
      }
      return { ok: true, json: () => Promise.resolve([]) };
    }));

    const config = makeConfig({
      minAddressVolumeUsd: 0, // accept all for test
      minAddressTrades: 1,
    });
    const scanner = new WhaleScanner(db, config, 'https://gamma.test', 'https://clob.test');

    const profiles = await scanner.triggerScan();
    expect(profiles.length).toBeGreaterThan(0);

    const state = scanner.getState();
    expect(state.marketsScanned).toBe(2);
    expect(state.totalScansCompleted).toBe(1);
    expect(state.lastScanAt).toBeTruthy();
    expect(state.status).not.toBe('scanning');

    // Each profile should have valid fields
    for (const p of profiles) {
      expect(p.address).toBeTruthy();
      expect(p.totalVolumeUsd).toBeGreaterThan(0);
      expect(p.totalTrades).toBeGreaterThan(0);
      expect(p.compositeScore).toBeGreaterThanOrEqual(0);
      expect(p.compositeScore).toBeLessThanOrEqual(100);
      expect(typeof p.estimatedWinRate).toBe('number');
      expect(typeof p.estimatedRoi).toBe('number');
      expect(Array.isArray(p.suggestedTags)).toBe(true);
      expect(Array.isArray(p.marketBreakdown)).toBe(true);
      expect(typeof p.alreadyTracked).toBe('boolean');
      expect(typeof p.alreadyCandidate).toBe('boolean');
    }

    // Results should be sorted by compositeScore descending
    for (let i = 1; i < profiles.length; i++) {
      expect(profiles[i - 1].compositeScore).toBeGreaterThanOrEqual(profiles[i].compositeScore);
    }

    vi.unstubAllGlobals();
  });

  it('returns empty profiles when no liquid markets found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    }));

    const scanner = new WhaleScanner(db, makeConfig(), 'https://gamma.test', 'https://clob.test');
    const profiles = await scanner.triggerScan();
    expect(profiles).toEqual([]);

    vi.unstubAllGlobals();
  });

  it('handles fetch failure gracefully (stays idle with empty results)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network failure')));

    const config = makeConfig();
    const scanner = new WhaleScanner(db, config, 'https://gamma.test', 'https://clob.test');
    const profiles = await scanner.triggerScan();
    expect(profiles).toEqual([]);

    // fetchWithRetry catches errors and returns null → empty markets → idle/paused
    const state = scanner.getState();
    expect(['idle', 'paused']).toContain(state.status);
    expect(state.marketsScanned).toBe(0);

    vi.unstubAllGlobals();
  }, 15_000);

  it('enters error state on unexpected internal error', async () => {
    const markets = gammaMarkets(1);

    // Return valid markets, but a broken response for trades that causes a parse error
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/markets')) return { ok: true, json: () => Promise.resolve(markets) };
      // Return an object whose json() throws
      return { ok: true, json: () => { throw new Error('corrupt response'); } };
    }));

    const config = makeConfig({ minAddressVolumeUsd: 0, minAddressTrades: 1 });
    const scanner = new WhaleScanner(db, config, 'https://gamma.test', 'https://clob.test');
    const profiles = await scanner.triggerScan();
    expect(profiles).toEqual([]);

    const state = scanner.getState();
    expect(state.status).toBe('error');
    expect(state.lastError).toBeTruthy();

    vi.unstubAllGlobals();
  }, 15_000);

  it('getResults returns profiles after a scan', async () => {
    const markets = gammaMarkets(1);
    const trades = clobTrades('0xcond_market_0', 2, 5);

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/markets')) {
        return { ok: true, json: () => Promise.resolve(markets) };
      }
      return { ok: true, json: () => Promise.resolve(trades) };
    }));

    const config = makeConfig({ minAddressVolumeUsd: 0, minAddressTrades: 1 });
    const scanner = new WhaleScanner(db, config, 'https://gamma.test', 'https://clob.test');

    await scanner.triggerScan();
    const results = scanner.getResults();
    expect(results.length).toBeGreaterThan(0);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ address: expect.any(String) }),
    ]));

    vi.unstubAllGlobals();
  });
});

/* ── Helper: build a single data-api-style trade ── */
function trade(overrides: {
  id?: string; market?: string; side?: string; size?: number; price?: number;
  timestamp?: number; owner?: string; outcome?: string;
} = {}): Record<string, unknown> {
  return {
    transactionHash: overrides.id ?? `0xtx_${Math.random().toString(36).slice(2)}`,
    proxyWallet: overrides.owner ?? `0x${'abcd'.repeat(10)}`,
    asset: `tok_${overrides.market ?? 'market_0'}_yes`,
    side: overrides.side ?? 'BUY',
    size: overrides.size ?? 100,
    price: overrides.price ?? 0.60,
    timestamp: overrides.timestamp ?? Math.floor(Date.now() / 1000),
    outcome: overrides.outcome ?? 'Yes',
    conditionId: `0xcond_${overrides.market ?? 'market_0'}`,
  };
}

describe('WhaleScanner — Profile fields', () => {
  it('marks existing tracked whales as alreadyTracked', async () => {
    // Pre-add a whale
    const addr = '0xabcdabcdabcdabcd00000000';
    db.addWhale(addr);

    const markets = gammaMarkets(1);
    const nowSec = Math.floor(Date.now() / 1000);
    const trades = [
      trade({ id: 'tx1', market: 'market_0', side: 'BUY', size: 100, price: 0.60, timestamp: nowSec, owner: addr }),
      trade({ id: 'tx2', market: 'market_0', side: 'SELL', size: 100, price: 0.70, timestamp: nowSec + 60, owner: addr }),
    ];

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/markets')) return { ok: true, json: () => Promise.resolve(markets) };
      return { ok: true, json: () => Promise.resolve(trades) };
    }));

    const config = makeConfig({ minAddressVolumeUsd: 0, minAddressTrades: 1 });
    const scanner = new WhaleScanner(db, config, 'https://gamma.test', 'https://clob.test');
    const profiles = await scanner.triggerScan();

    const match = profiles.find((p) => p.address === addr.toLowerCase());
    expect(match).toBeDefined();
    expect(match!.alreadyTracked).toBe(true);

    vi.unstubAllGlobals();
  });

  it('computes per-market breakdown', async () => {
    const markets = gammaMarkets(2);
    const addr = '0xdeadbeefdeadbeef00000001';
    const nowSec = Math.floor(Date.now() / 1000);
    const trades0 = [
      trade({ id: 'tx1', market: 'market_0', side: 'BUY', size: 50, price: 0.55, timestamp: nowSec, owner: addr }),
    ];
    const trades1 = [
      trade({ id: 'tx2', market: 'market_1', side: 'BUY', size: 80, price: 0.60, timestamp: nowSec, owner: addr }),
    ];

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/markets')) return { ok: true, json: () => Promise.resolve(markets) };
      if (url.includes('market=0xcond_market_0')) return { ok: true, json: () => Promise.resolve(trades0) };
      if (url.includes('market=0xcond_market_1')) return { ok: true, json: () => Promise.resolve(trades1) };
      return { ok: true, json: () => Promise.resolve([]) };
    }));

    const config = makeConfig({ minAddressVolumeUsd: 0, minAddressTrades: 1 });
    const scanner = new WhaleScanner(db, config, 'https://gamma.test', 'https://clob.test');
    const profiles = await scanner.triggerScan();

    const match = profiles.find((p) => p.address === addr.toLowerCase());
    expect(match).toBeDefined();
    expect(match!.marketBreakdown.length).toBe(2);
    for (const mb of match!.marketBreakdown) {
      expect(mb.marketId).toBeTruthy();
      expect(mb.question).toBeTruthy();
      expect(mb.volumeUsd).toBeGreaterThan(0);
      expect(['BUY', 'SELL', 'NEUTRAL']).toContain(mb.netSide);
    }

    vi.unstubAllGlobals();
  });

  it('infers tags based on behaviour', async () => {
    const markets = gammaMarkets(1);
    const addr = '0xaaaa1111bbbb222200000002';
    const nowSec = Math.floor(Date.now() / 1000);

    // Many buys, high volume
    const trades: unknown[] = [];
    for (let i = 0; i < 60; i++) {
      trades.push(
        trade({ id: `tx_${i}`, market: 'market_0', side: 'BUY', size: 3000, price: 0.60, timestamp: nowSec - i * 60, owner: addr }),
      );
    }

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/markets')) return { ok: true, json: () => Promise.resolve(markets) };
      return { ok: true, json: () => Promise.resolve(trades) };
    }));

    const config = makeConfig({ minAddressVolumeUsd: 0, minAddressTrades: 1 });
    const scanner = new WhaleScanner(db, config, 'https://gamma.test', 'https://clob.test');
    const profiles = await scanner.triggerScan();

    const match = profiles.find((p) => p.address === addr.toLowerCase());
    expect(match).toBeDefined();
    expect(match!.suggestedTags).toContain('high_volume');
    expect(match!.suggestedTags).toContain('aggressive_buyer');
    expect(match!.suggestedTags).toContain('frequent_trader');

    vi.unstubAllGlobals();
  });
});

describe('WhaleScanner — Auto-promote', () => {
  it('promotes qualifying whales when autoPromoteEnabled', async () => {
    const markets = gammaMarkets(1);
    const addr = '0xpromote0000000000000001';
    const nowSec = Math.floor(Date.now() / 1000);

    // Create profitable trade pattern — 5 buy-sell pairs
    const trades = Array.from({ length: 5 }, (_, i) => [
      trade({ id: `b${i}`, market: 'market_0', side: 'BUY', size: 200, price: 0.40, timestamp: nowSec - (10 - i * 2) * 60, owner: addr }),
      trade({ id: `s${i}`, market: 'market_0', side: 'SELL', size: 200, price: 0.70, timestamp: nowSec - (9 - i * 2) * 60, owner: addr }),
    ]).flat();

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/markets')) return { ok: true, json: () => Promise.resolve(markets) };
      return { ok: true, json: () => Promise.resolve(trades) };
    }));

    const config = makeConfig({
      minAddressVolumeUsd: 0,
      minAddressTrades: 1,
      autoPromoteEnabled: true,
      autoPromoteMinScore: 0, // low threshold for test
      minWinRate: 0,
      minRoi: -1,
      autoPromoteMaxPerScan: 5,
    });

    const scanner = new WhaleScanner(db, config, 'https://gamma.test', 'https://clob.test');
    await scanner.triggerScan();

    // The address should now be a tracked whale in the DB
    const whale = db.getWhaleByAddress(addr.toLowerCase());
    expect(whale).toBeDefined();
    expect(whale!.tags).toContain('scanner_discovered');

    vi.unstubAllGlobals();
  });

  it('does not promote when autoPromoteEnabled is false', async () => {
    const markets = gammaMarkets(1);
    const addr = '0xnopromote000000000000001';
    const nowSec = Math.floor(Date.now() / 1000);
    const trades = [
      trade({ id: 'b1', market: 'market_0', side: 'BUY', size: 200, price: 0.40, timestamp: nowSec, owner: addr }),
      trade({ id: 's1', market: 'market_0', side: 'SELL', size: 200, price: 0.70, timestamp: nowSec + 60, owner: addr }),
    ];

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/markets')) return { ok: true, json: () => Promise.resolve(markets) };
      return { ok: true, json: () => Promise.resolve(trades) };
    }));

    const config = makeConfig({
      minAddressVolumeUsd: 0,
      minAddressTrades: 1,
      autoPromoteEnabled: false,
    });

    const scanner = new WhaleScanner(db, config, 'https://gamma.test', 'https://clob.test');
    await scanner.triggerScan();

    const whale = db.getWhaleByAddress(addr.toLowerCase());
    expect(whale).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it('respects autoPromoteMaxPerScan limit', async () => {
    const markets = gammaMarkets(1);
    const nowSec = Math.floor(Date.now() / 1000);
    // Create 5 distinct addresses with profitable trades
    const trades: unknown[] = [];
    for (let a = 0; a < 5; a++) {
      const addr = `0xbulk${a.toString(16).padStart(36, '0')}`;
      for (let i = 0; i < 6; i++) {
        trades.push(
          trade({ id: `b_${a}_${i}`, market: 'market_0', side: 'BUY', size: 100, price: 0.40, timestamp: nowSec - (50 - a * 10 - i) * 60, owner: addr }),
          trade({ id: `s_${a}_${i}`, market: 'market_0', side: 'SELL', size: 100, price: 0.70, timestamp: nowSec - (49 - a * 10 - i) * 60, owner: addr }),
        );
      }
    }

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/markets')) return { ok: true, json: () => Promise.resolve(markets) };
      return { ok: true, json: () => Promise.resolve(trades) };
    }));

    const config = makeConfig({
      minAddressVolumeUsd: 0,
      minAddressTrades: 1,
      autoPromoteEnabled: true,
      autoPromoteMinScore: 0,
      minWinRate: 0,
      minRoi: -1,
      autoPromoteMaxPerScan: 2, // Only promote 2
    });

    const scanner = new WhaleScanner(db, config, 'https://gamma.test', 'https://clob.test');
    await scanner.triggerScan();

    const allWhales = db.listWhales({ limit: 100 });
    expect(allWhales.total).toBeLessThanOrEqual(2);

    vi.unstubAllGlobals();
  });
});

describe('WhaleScanner — FIFO PnL estimation', () => {
  it('estimates positive PnL from profitable buy-sell pairs', async () => {
    const markets = gammaMarkets(1);
    const addr = '0xpnltest00000000000000001';

    // Buy low, sell high
    const trades = [
      trade({ id: 'b1', market: 'market_0', side: 'BUY', size: 100, price: 0.40, timestamp: 1704067200, owner: addr }),
      trade({ id: 'b2', market: 'market_0', side: 'BUY', size: 50, price: 0.45, timestamp: 1704067260, owner: addr }),
      trade({ id: 's1', market: 'market_0', side: 'SELL', size: 100, price: 0.70, timestamp: 1704067320, owner: addr }),
      trade({ id: 's2', market: 'market_0', side: 'SELL', size: 50, price: 0.65, timestamp: 1704067380, owner: addr }),
    ];

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/markets')) return { ok: true, json: () => Promise.resolve(markets) };
      return { ok: true, json: () => Promise.resolve(trades) };
    }));

    const config = makeConfig({ minAddressVolumeUsd: 0, minAddressTrades: 1 });
    const scanner = new WhaleScanner(db, config, 'https://gamma.test', 'https://clob.test');
    const profiles = await scanner.triggerScan();

    const match = profiles.find((p) => p.address === addr.toLowerCase());
    expect(match).toBeDefined();
    // PnL should be positive: bought at 0.40/0.45, sold at 0.70/0.65
    expect(match!.estimatedPnlUsd).toBeGreaterThan(0);
    expect(match!.estimatedWinRate).toBeGreaterThan(0);

    vi.unstubAllGlobals();
  });

  it('estimates negative PnL from losing trades', async () => {
    const markets = gammaMarkets(1);
    const addr = '0xlosertest0000000000000001';

    // Buy high, sell low
    const trades = [
      trade({ id: 'b1', market: 'market_0', side: 'BUY', size: 100, price: 0.70, timestamp: 1704067200, owner: addr }),
      trade({ id: 's1', market: 'market_0', side: 'SELL', size: 100, price: 0.40, timestamp: 1704067260, owner: addr }),
    ];

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/markets')) return { ok: true, json: () => Promise.resolve(markets) };
      return { ok: true, json: () => Promise.resolve(trades) };
    }));

    const config = makeConfig({ minAddressVolumeUsd: 0, minAddressTrades: 1 });
    const scanner = new WhaleScanner(db, config, 'https://gamma.test', 'https://clob.test');
    const profiles = await scanner.triggerScan();

    const match = profiles.find((p) => p.address === addr.toLowerCase());
    expect(match).toBeDefined();
    expect(match!.estimatedPnlUsd).toBeLessThan(0);

    vi.unstubAllGlobals();
  });
});

describe('WhaleScanner — getProfile', () => {
  it('returns a single profile by address after scan', async () => {
    const markets = gammaMarkets(1);
    const addr = '0xprofiletest000000000000001';
    const nowSec = Math.floor(Date.now() / 1000);
    const trades = [
      trade({ id: 'b1', market: 'market_0', side: 'BUY', size: 100, price: 0.50, timestamp: nowSec - 600, owner: addr }),
      trade({ id: 's1', market: 'market_0', side: 'SELL', size: 100, price: 0.70, timestamp: nowSec, owner: addr }),
    ];

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/markets')) return { ok: true, json: () => Promise.resolve(markets) };
      return { ok: true, json: () => Promise.resolve(trades) };
    }));

    const config = makeConfig({ minAddressVolumeUsd: 0, minAddressTrades: 1 });
    const scanner = new WhaleScanner(db, config, 'https://gamma.test', 'https://clob.test');
    await scanner.triggerScan();

    const profile = scanner.getProfile(addr);
    expect(profile).toBeDefined();
    expect(profile!.address).toBe(addr.toLowerCase());
    expect(profile!.totalVolumeUsd).toBeGreaterThan(0);

    vi.unstubAllGlobals();
  });

  it('returns undefined for unknown address', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    }));

    const scanner = new WhaleScanner(db, makeConfig(), 'https://gamma.test', 'https://clob.test');
    await scanner.triggerScan();

    const profile = scanner.getProfile('0xnonexistent');
    expect(profile).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it('is case-insensitive on address lookup', async () => {
    const markets = gammaMarkets(1);
    const addr = '0xCASEtest0000000000000001';
    const nowSec = Math.floor(Date.now() / 1000);
    const trades = [
      trade({ id: 'b1', market: 'market_0', side: 'BUY', size: 100, price: 0.50, timestamp: nowSec, owner: addr }),
    ];

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/markets')) return { ok: true, json: () => Promise.resolve(markets) };
      return { ok: true, json: () => Promise.resolve(trades) };
    }));

    const config = makeConfig({ minAddressVolumeUsd: 0, minAddressTrades: 1 });
    const scanner = new WhaleScanner(db, config, 'https://gamma.test', 'https://clob.test');
    await scanner.triggerScan();

    // Look up with different case
    const profile = scanner.getProfile(addr.toUpperCase());
    expect(profile).toBeDefined();
    expect(profile!.address).toBe(addr.toLowerCase());

    vi.unstubAllGlobals();
  });
});

describe('WhaleScanner — Enriched profile fields', () => {
  it('computes hold time, streaks, and enriched market breakdown', async () => {
    const markets = gammaMarkets(1);
    const addr = '0xenrichedtest00000000000001';
    const baseTs = 1704067200; // fixed epoch seconds

    // Create 3 buy-sell pairs: 2 wins, 1 loss
    const trades = [
      trade({ id: 'b1', market: 'market_0', side: 'BUY', size: 100, price: 0.40, timestamp: baseTs, owner: addr }),
      trade({ id: 's1', market: 'market_0', side: 'SELL', size: 100, price: 0.60, timestamp: baseTs + 3600, owner: addr }), // win after 1hr
      trade({ id: 'b2', market: 'market_0', side: 'BUY', size: 100, price: 0.50, timestamp: baseTs + 7200, owner: addr }),
      trade({ id: 's2', market: 'market_0', side: 'SELL', size: 100, price: 0.70, timestamp: baseTs + 10800, owner: addr }), // win after 1hr
      trade({ id: 'b3', market: 'market_0', side: 'BUY', size: 100, price: 0.65, timestamp: baseTs + 14400, owner: addr }),
      trade({ id: 's3', market: 'market_0', side: 'SELL', size: 100, price: 0.50, timestamp: baseTs + 18000, owner: addr }), // loss after 1hr
    ];

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/markets')) return { ok: true, json: () => Promise.resolve(markets) };
      return { ok: true, json: () => Promise.resolve(trades) };
    }));

    const config = makeConfig({ minAddressVolumeUsd: 0, minAddressTrades: 1 });
    const scanner = new WhaleScanner(db, config, 'https://gamma.test', 'https://clob.test');
    const profiles = await scanner.triggerScan();

    const p = profiles.find((p) => p.address === addr.toLowerCase());
    expect(p).toBeDefined();

    // Hold time: all 3 trades held for exactly 1 hour = 1.0 hrs
    expect(p!.avgHoldTimeHrs).toBeCloseTo(1.0, 0);
    expect(p!.medianHoldTimeHrs).toBeCloseTo(1.0, 0);

    // Closed trades: 3
    expect(p!.closedTrades).toBe(3);

    // Win rate: 2/3
    expect(p!.estimatedWinRate).toBeCloseTo(0.667, 1);

    // Streaks: 2 wins then 1 loss → longest win streak = 2, longest loss streak = 1
    expect(p!.longestWinStreak).toBe(2);
    expect(p!.longestLossStreak).toBe(1);

    // Current streak: last trade was a loss → -1
    expect(p!.currentStreak).toBe(-1);

    // Largest win: 100 * (0.70 - 0.50) = 20 or 100 * (0.60 - 0.40) = 20
    expect(p!.largestWinUsd).toBeGreaterThan(0);

    // Largest loss: 100 * (0.50 - 0.65) = -15
    expect(p!.largestLossUsd).toBeLessThan(0);

    // First/last trade timestamps
    expect(p!.firstTradeTs).toBeTruthy();
    expect(p!.lastTradeTs).toBeTruthy();
    expect(p!.tradingSpanDays).toBeGreaterThanOrEqual(0);

    // Market breakdown should have enriched fields
    expect(p!.marketBreakdown.length).toBe(1);
    const mb = p!.marketBreakdown[0];
    expect(mb.avgEntryPrice).toBeGreaterThan(0);
    expect(mb.avgExitPrice).toBeGreaterThan(0);
    expect(mb.avgHoldTimeHrs).toBeGreaterThanOrEqual(0);
    expect(typeof mb.openPositionSize).toBe('number');
    expect(['active', 'closed']).toContain(mb.positionStatus);
    expect(mb.firstTradeTs).toBeTruthy();

    vi.unstubAllGlobals();
  });
});

describe('WhaleScanner — State enrichment', () => {
  it('includes new state fields after a scan', async () => {
    const markets = gammaMarkets(2);
    const trades0 = clobTrades('0xcond_market_0', 2, 4);
    const trades1 = clobTrades('0xcond_market_1', 2, 4);

    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/markets')) return { ok: true, json: () => Promise.resolve(markets) };
      if (url.includes('market=0xcond_market_0')) return { ok: true, json: () => Promise.resolve(trades0) };
      if (url.includes('market=0xcond_market_1')) return { ok: true, json: () => Promise.resolve(trades1) };
      return { ok: true, json: () => Promise.resolve([]) };
    }));

    const config = makeConfig({ minAddressVolumeUsd: 0, minAddressTrades: 1 });
    const scanner = new WhaleScanner(db, config, 'https://gamma.test', 'https://clob.test');
    await scanner.triggerScan();

    const state = scanner.getState();
    expect(state.totalMarketsDiscovered).toBeGreaterThan(0);
    expect(state.batchNumber).toBe(1);
    expect(typeof state.totalScanTimeMs).toBe('number');
    expect(typeof state.marketsInCurrentBatch).toBe('number');

    vi.unstubAllGlobals();
  });
});
