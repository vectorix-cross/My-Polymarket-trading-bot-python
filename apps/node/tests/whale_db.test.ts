import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { WhaleDB } from '../src/whales/whale_db';

const TEST_DB_PATH = path.join(__dirname, '.test_whale.db');

let db: WhaleDB;

beforeEach(() => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  db = new WhaleDB(TEST_DB_PATH);
});

afterEach(() => {
  db.close();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   WHALE CRUD
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

describe('WhaleDB — Whale CRUD', () => {
  it('adds a whale and retrieves by id', () => {
    const whale = db.addWhale('0xABCDEF1234567890', {
      displayName: 'Big Fish',
      tags: ['degen', 'early'],
      notes: 'Top trader',
    });
    expect(whale.id).toBeGreaterThan(0);
    expect(whale.address).toBe('0xabcdef1234567890'); // lowercased
    expect(whale.displayName).toBe('Big Fish');
    expect(whale.tags).toEqual(['degen', 'early']);
    expect(whale.trackingEnabled).toBe(true);
    expect(whale.style).toBe('UNKNOWN');

    const fetched = db.getWhale(whale.id);
    expect(fetched).toBeDefined();
    expect(fetched!.address).toBe(whale.address);
  });

  it('retrieves a whale by address (case-insensitive)', () => {
    db.addWhale('0xABC123');
    const whale = db.getWhaleByAddress('0xabc123');
    expect(whale).toBeDefined();
    expect(whale!.address).toBe('0xabc123');
  });

  it('lists whales with filters', () => {
    db.addWhale('0x001');
    db.addWhale('0x002');
    const w3 = db.addWhale('0x003');
    db.updateWhale(w3.id, { starred: true });

    const { whales: all, total } = db.listWhales();
    expect(total).toBe(3);
    expect(all).toHaveLength(3);

    const { whales: starred } = db.listWhales({ starred: true });
    expect(starred).toHaveLength(1);
    expect(starred[0].address).toBe('0x003');
  });

  it('updates whale fields', () => {
    const whale = db.addWhale('0xupdate');
    db.updateWhale(whale.id, {
      displayName: 'Updated Name',
      starred: true,
      style: 'INFORMED',
      tags: ['alpha'],
      copyMode: 'PAPER_SHADOW',
    });
    const updated = db.getWhale(whale.id)!;
    expect(updated.displayName).toBe('Updated Name');
    expect(updated.starred).toBe(true);
    expect(updated.style).toBe('INFORMED');
    expect(updated.tags).toEqual(['alpha']);
    expect(updated.copyMode).toBe('PAPER_SHADOW');
  });

  it('soft-deletes a whale by disabling tracking', () => {
    const whale = db.addWhale('0xdelete');
    db.deleteWhale(whale.id);
    const deleted = db.getWhale(whale.id)!;
    expect(deleted.trackingEnabled).toBe(false);
  });

  it('bulk adds whales (ignores duplicates)', () => {
    db.addWhale('0x001');
    const whales = db.bulkAddWhales(['0x001', '0x002', '0x003']);
    expect(whales).toHaveLength(3);
    const { total } = db.listWhales();
    expect(total).toBe(3);
  });

  it('upserts on conflict — preserves existing display_name', () => {
    db.addWhale('0xdup', { displayName: 'First' });
    const second = db.addWhale('0xDUP'); // uppercase collision
    expect(second.displayName).toBe('First');
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   TRADES
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

describe('WhaleDB — Trades', () => {
  it('inserts a trade and retrieves it', () => {
    const whale = db.addWhale('0xtrader');
    const tradeId = db.insertTrade({
      whaleId: whale.id,
      tradeId: 'trade_001',
      logicalTradeGroupId: null,
      marketId: 'POLY-MKT-1',
      outcome: 'YES',
      side: 'BUY',
      price: 0.65,
      size: 100,
      notionalUsd: 65,
      feeUsd: 0.5,
      isFeeEstimated: true,
      ts: '2025-01-01T12:00:00Z',
      midpointAtFill: 0.64,
      bestBidAtFill: 0.63,
      bestAskAtFill: 0.66,
      slippageBps: 15,
      aggressor: 'BUY',
    });
    expect(tradeId).toBeGreaterThan(0);

    const trades = db.getWhaleTrades(whale.id);
    expect(trades).toHaveLength(1);
    expect(trades[0].price).toBe(0.65);
    expect(trades[0].side).toBe('BUY');
    expect(trades[0].marketId).toBe('POLY-MKT-1');
  });

  it('deduplicates trades by (whale_id, trade_id)', () => {
    const whale = db.addWhale('0xdedup');
    const baseTrade = {
      whaleId: whale.id,
      tradeId: 'trade_dup',
      logicalTradeGroupId: null,
      marketId: 'MKT-1',
      outcome: 'YES',
      side: 'BUY' as const,
      price: 0.5,
      size: 50,
      notionalUsd: 25,
      feeUsd: 0,
      isFeeEstimated: true,
      ts: '2025-01-01T00:00:00Z',
      midpointAtFill: null,
      bestBidAtFill: null,
      bestAskAtFill: null,
      slippageBps: null,
      aggressor: 'UNKNOWN' as const,
    };
    db.insertTrade(baseTrade);
    db.insertTrade(baseTrade); // duplicate
    const trades = db.getWhaleTrades(whale.id);
    expect(trades).toHaveLength(1);
  });

  it('batch inserts trades correctly', () => {
    const whale = db.addWhale('0xbatch');
    const trades = Array.from({ length: 5 }, (_, i) => ({
      whaleId: whale.id,
      tradeId: `batch_${i}`,
      logicalTradeGroupId: null,
      marketId: 'MKT-1',
      outcome: 'YES',
      side: 'BUY' as const,
      price: 0.5 + i * 0.01,
      size: 10,
      notionalUsd: 5 + i * 0.1,
      feeUsd: 0,
      isFeeEstimated: true,
      ts: `2025-01-0${i + 1}T00:00:00Z`,
      midpointAtFill: null,
      bestBidAtFill: null,
      bestAskAtFill: null,
      slippageBps: null,
      aggressor: 'UNKNOWN' as const,
    }));
    const inserted = db.insertTrades(trades);
    expect(inserted).toBe(5);
    expect(db.getWhaleTrades(whale.id)).toHaveLength(5);
  });

  it('counts trades and sums volume', () => {
    const whale = db.addWhale('0xstats');
    db.insertTrades([
      makeTrade(whale.id, 'a', 100, '2025-01-01T00:00:00Z'),
      makeTrade(whale.id, 'b', 200, '2025-01-02T00:00:00Z'),
      makeTrade(whale.id, 'c', 300, '2025-01-03T00:00:00Z'),
    ]);
    expect(db.getWhaleTradeCount(whale.id)).toBe(3);
    expect(db.getWhaleVolume(whale.id)).toBe(600);
    expect(db.getWhaleTradeCount(whale.id, '2025-01-02T00:00:00Z')).toBe(2);
    expect(db.getWhaleVolume(whale.id, '2025-01-02T00:00:00Z')).toBe(500);
  });

  it('counts distinct markets', () => {
    const whale = db.addWhale('0xmarkets');
    db.insertTrade(makeTrade(whale.id, 't1', 100, '2025-01-01T00:00:00Z', 'MKT-1'));
    db.insertTrade(makeTrade(whale.id, 't2', 100, '2025-01-01T00:00:00Z', 'MKT-2'));
    db.insertTrade(makeTrade(whale.id, 't3', 100, '2025-01-01T00:00:00Z', 'MKT-1'));
    expect(db.getWhaleDistinctMarkets(whale.id)).toBe(2);
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   POSITIONS
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

describe('WhaleDB — Positions', () => {
  it('upserts and retrieves positions', () => {
    const whale = db.addWhale('0xpos');
    db.upsertPosition({
      whaleId: whale.id,
      marketId: 'MKT-1',
      outcome: 'YES',
      netShares: 100,
      avgEntryPrice: 0.55,
      costBasis: 55,
      unrealizedPnl: 10,
      updatedAt: new Date().toISOString(),
    });
    const positions = db.getPositions(whale.id);
    expect(positions).toHaveLength(1);
    expect(positions[0].netShares).toBe(100);
    expect(positions[0].avgEntryPrice).toBe(0.55);
  });

  it('updates existing position on upsert', () => {
    const whale = db.addWhale('0xpos_up');
    const pos = {
      whaleId: whale.id,
      marketId: 'MKT-1',
      outcome: 'YES',
      netShares: 100,
      avgEntryPrice: 0.55,
      costBasis: 55,
      unrealizedPnl: 0,
      updatedAt: new Date().toISOString(),
    };
    db.upsertPosition(pos);
    db.upsertPosition({ ...pos, netShares: 200, avgEntryPrice: 0.52 });
    const positions = db.getPositions(whale.id);
    expect(positions).toHaveLength(1);
    expect(positions[0].netShares).toBe(200);
  });

  it('filters out zero-share positions', () => {
    const whale = db.addWhale('0xzero');
    db.upsertPosition({
      whaleId: whale.id,
      marketId: 'MKT-1',
      outcome: 'YES',
      netShares: 0,
      avgEntryPrice: 0,
      costBasis: 0,
      unrealizedPnl: 0,
      updatedAt: new Date().toISOString(),
    });
    expect(db.getPositions(whale.id)).toHaveLength(0);
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   SETTLEMENT LEDGER
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

describe('WhaleDB — Settlement Ledger', () => {
  it('inserts entries and computes settled PnL', () => {
    const whale = db.addWhale('0xsettle');

    // Open position
    db.insertSettlementEntry({
      whaleId: whale.id,
      marketId: 'MKT-1',
      outcome: 'YES',
      lotId: 'lot-1',
      openTs: '2025-01-01T00:00:00Z',
      closeTs: '2025-01-05T00:00:00Z',
      qty: 100,
      entryPrice: 0.50,
      exitPriceOrSettlement: 0.70,
      realizedPnl: 20,
      feeUsd: 0.5,
      method: 'FIFO',
      isEstimatedFee: false,
    });

    db.insertSettlementEntry({
      whaleId: whale.id,
      marketId: 'MKT-2',
      outcome: 'NO',
      lotId: 'lot-2',
      openTs: '2025-01-02T00:00:00Z',
      closeTs: '2025-01-06T00:00:00Z',
      qty: 50,
      entryPrice: 0.40,
      exitPriceOrSettlement: 0.30,
      realizedPnl: -5,
      feeUsd: 0.3,
      method: 'FIFO',
      isEstimatedFee: true,
    });

    expect(db.getSettledPnl(whale.id)).toBe(15); // 20 + (-5)
    expect(db.getSettlementEntries(whale.id)).toHaveLength(2);
  });

  it('computes win rate correctly', () => {
    const whale = db.addWhale('0xwinrate');
    // 2 wins, 1 loss
    for (const [pnl, i] of [[10, 0], [5, 1], [-3, 2]] as [number, number][]) {
      db.insertSettlementEntry({
        whaleId: whale.id,
        marketId: `MKT-${i}`,
        outcome: 'YES',
        lotId: `lot-${i}`,
        openTs: `2025-01-0${i + 1}T00:00:00Z`,
        closeTs: `2025-01-0${i + 2}T00:00:00Z`,
        qty: 100,
        entryPrice: 0.5,
        exitPriceOrSettlement: 0.5 + pnl / 100,
        realizedPnl: pnl,
        feeUsd: 0,
        method: 'FIFO',
        isEstimatedFee: false,
      });
    }
    const winRate = db.getWinRate(whale.id);
    expect(winRate).toBeCloseTo(2 / 3, 5);
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   CANDIDATES
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

describe('WhaleDB — Candidates', () => {
  it('upserts and lists candidates', () => {
    db.upsertCandidate({
      address: '0xCandidate1',
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      volumeUsd24h: 50000,
      trades24h: 25,
      maxSingleTradeUsd: 10000,
      markets7d: 5,
      rankScore: 85,
      suggestedTags: ['heavy-hitter'],
      mutedUntil: null,
      approved: false,
    });
    const candidates = db.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].address).toBe('0xcandidate1');
    expect(candidates[0].rankScore).toBe(85);
  });

  it('approves and mutes candidates', () => {
    db.upsertCandidate({
      address: '0xapprove_me',
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      volumeUsd24h: 10000,
      trades24h: 10,
      maxSingleTradeUsd: 5000,
      markets7d: 3,
      rankScore: 60,
      suggestedTags: [],
      mutedUntil: null,
      approved: false,
    });
    db.approveCandidate('0xapprove_me');
    const after = db.listCandidates({ excludeApproved: true });
    expect(after).toHaveLength(0);

    // Re-add to test mute
    db.upsertCandidate({
      address: '0xmute_me',
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      volumeUsd24h: 5000,
      trades24h: 5,
      maxSingleTradeUsd: 2000,
      markets7d: 2,
      rankScore: 30,
      suggestedTags: [],
      mutedUntil: null,
      approved: false,
    });
    db.muteCandidate('0xmute_me', 30);
    const muted = db.listCandidates({ excludeMuted: true });
    expect(muted.find(c => c.address === '0xmute_me')).toBeUndefined();
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ALERTS + SIGNALS
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

describe('WhaleDB — Alerts & Signals', () => {
  it('inserts and lists alerts', () => {
    const whale = db.addWhale('0xalert');
    db.insertAlert({
      whaleId: whale.id,
      type: 'large_trade',
      payload: { size: 5000 },
      createdAt: new Date().toISOString(),
      delivered: false,
      readAt: null,
    });
    db.insertAlert({
      whaleId: whale.id,
      type: 'new_market_entry',
      payload: { market: 'POLY-1' },
      createdAt: new Date().toISOString(),
      delivered: false,
      readAt: null,
    });

    const alerts = db.listAlerts({ whaleId: whale.id });
    expect(alerts).toHaveLength(2);
    expect(db.getUnreadAlertCount()).toBe(2);
  });

  it('marks alerts as read', () => {
    const whale = db.addWhale('0xread');
    const alertId = db.insertAlert({
      whaleId: whale.id,
      type: 'score_surge',
      payload: {},
      createdAt: new Date().toISOString(),
      delivered: false,
      readAt: null,
    });
    db.markAlertRead(alertId);
    const alerts = db.listAlerts({ unreadOnly: true });
    expect(alerts).toHaveLength(0);
    expect(db.getUnreadAlertCount()).toBe(0);
  });

  it('marks all alerts read (global)', () => {
    const whale = db.addWhale('0xbulkread');
    for (let i = 0; i < 3; i++) {
      db.insertAlert({
        whaleId: whale.id,
        type: 'new_trade',
        payload: {},
        createdAt: new Date().toISOString(),
        delivered: false,
        readAt: null,
      });
    }
    expect(db.getUnreadAlertCount()).toBe(3);
    db.markAllAlertsRead();
    expect(db.getUnreadAlertCount()).toBe(0);
  });

  it('inserts and lists signals', () => {
    db.insertSignal({
      type: 'whale_trade',
      payload: { whaleId: 1, size: 500 },
      createdAt: new Date().toISOString(),
      cursorKey: 'sig_001',
    });
    const signals = db.listSignals();
    expect(signals).toHaveLength(1);
    expect(signals[0].type).toBe('whale_trade');
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   WATCHLISTS
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

describe('WhaleDB — Watchlists', () => {
  it('creates a watchlist and adds whales', () => {
    const whale1 = db.addWhale('0xwl1');
    const whale2 = db.addWhale('0xwl2');
    const wl = db.createWatchlist('Top Traders');

    db.addToWatchlist(wl.id, whale1.id);
    db.addToWatchlist(wl.id, whale2.id);

    const items = db.getWatchlistItems(wl.id);
    expect(items).toHaveLength(2);

    const wls = db.listWatchlists();
    expect(wls).toHaveLength(1);
    expect(wls[0].name).toBe('Top Traders');
  });

  it('removes a whale from a watchlist', () => {
    const whale = db.addWhale('0xremove');
    const wl = db.createWatchlist('Removable');
    db.addToWatchlist(wl.id, whale.id);
    db.removeFromWatchlist(wl.id, whale.id);
    expect(db.getWatchlistItems(wl.id)).toHaveLength(0);
  });

  it('deletes a watchlist', () => {
    const wl = db.createWatchlist('Delete Me');
    db.deleteWatchlist(wl.id);
    expect(db.listWatchlists()).toHaveLength(0);
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   SHADOW PORTFOLIOS
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

describe('WhaleDB — Shadow Portfolios', () => {
  it('upserts and retrieves a shadow portfolio', () => {
    const whale = db.addWhale('0xshadow');
    db.upsertShadowPortfolio({
      whaleId: whale.id,
      mode: 'paper',
      positions: [
        { marketId: 'MKT-1', outcome: 'YES', side: 'BUY', shares: 50, entryPrice: 0.60, entryTs: '2025-01-01T00:00:00Z' },
      ],
      pnlSeries: [0, 5, 8, 12],
      totalPnl: 12,
      drawdown: 0.02,
      lastUpdated: new Date().toISOString(),
    });

    const sp = db.getShadowPortfolio(whale.id);
    expect(sp).toBeDefined();
    expect(sp!.positions).toHaveLength(1);
    expect(sp!.pnlSeries).toEqual([0, 5, 8, 12]);
    expect(sp!.totalPnl).toBe(12);
  });

  it('returns undefined for nonexistent shadow portfolio', () => {
    expect(db.getShadowPortfolio(9999)).toBeUndefined();
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   DAILY METRICS
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

describe('WhaleDB — Daily Metrics', () => {
  it('upserts and retrieves daily metrics', () => {
    const whale = db.addWhale('0xmetrics');
    const metrics = {
      whaleId: whale.id,
      date: '2025-01-15',
      realizedPnl: 120,
      unrealizedPnl: 30,
      volumeUsd: 5000,
      tradesCount: 15,
      winRate: 0.73,
      avgSlippageBps: 12,
      avgHoldMinutes: 480,
      timingScore: 75,
      consistencyScore: 80,
      marketSelectionScore: 65,
      score: 72,
      scoreConfidence: 0.85,
      scoreVersion: '1.0.0',
    };
    db.upsertDailyMetrics(metrics);

    const rows = db.getDailyMetrics(whale.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(72);
    expect(rows[0].winRate).toBe(0.73);
  });

  it('filters by date range', () => {
    const whale = db.addWhale('0xdaterange');
    for (let d = 10; d <= 15; d++) {
      db.upsertDailyMetrics({
        whaleId: whale.id,
        date: `2025-01-${d}`,
        realizedPnl: d * 10,
        unrealizedPnl: 0,
        volumeUsd: 100,
        tradesCount: 1,
        winRate: 0.5,
        avgSlippageBps: 5,
        avgHoldMinutes: 60,
        timingScore: 50,
        consistencyScore: 50,
        marketSelectionScore: 50,
        score: 50,
        scoreConfidence: 0.5,
        scoreVersion: '1.0.0',
      });
    }
    const filtered = db.getDailyMetrics(whale.id, { fromDate: '2025-01-12', toDate: '2025-01-14' });
    expect(filtered).toHaveLength(3);
    expect(filtered[0].date).toBe('2025-01-12');
    expect(filtered[2].date).toBe('2025-01-14');
  });
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   HELPERS
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function makeTrade(
  whaleId: number,
  tradeId: string,
  notionalUsd: number,
  ts: string,
  marketId = 'MKT-DEFAULT',
) {
  return {
    whaleId,
    tradeId,
    logicalTradeGroupId: null,
    marketId,
    outcome: 'YES',
    side: 'BUY' as const,
    price: 0.5,
    size: notionalUsd / 0.5,
    notionalUsd,
    feeUsd: 0,
    isFeeEstimated: true,
    ts,
    midpointAtFill: null,
    bestBidAtFill: null,
    bestAskAtFill: null,
    slippageBps: null,
    aggressor: 'UNKNOWN' as const,
  };
}
